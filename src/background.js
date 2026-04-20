import {
  DEFAULT_SETTINGS,
  GEMINI_MODELS,
  MESSAGE_TYPES,
  normalizeSttProvider,
  PRESET_LANGUAGE_PAIRS,
  RUNTIME_LOG_SOURCES,
  SESSION_STATUS,
  STT_CONNECTION_STATES,
  STT_PROVIDERS,
  STT_PROVIDER_SOURCE_LANGUAGE_SUPPORT,
  STT_TRANSPORTS,
  TRANSLATION_PROVIDERS
} from "./constants.js";
import { getTabSupport } from "./page-support.js";
import { createRuntimeLogger } from "./runtime-log.js";
import { getRuntimeLogs, getSettings, getSessionState, saveSessionState, saveSettings } from "./storage.js";

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const OFFSCREEN_REASONS = ["USER_MEDIA"];
const DEBUG_LOG_PREFIX = "[deepfram/background]";
const runtimeLogger = createRuntimeLogger(RUNTIME_LOG_SOURCES.background, DEBUG_LOG_PREFIX);
const IDLE_SESSION_STATE = {
  status: SESSION_STATUS.idle,
  activeTabId: null,
  runtimeSessionId: null,
  sttProvider: null,
  sttTransport: null,
  sttConnectionState: STT_CONNECTION_STATES.idle,
  utteranceIndex: 0,
  translationProvider: null,
  geminiModel: null,
  sourceLang: null,
  targetLang: null,
  message: "停止中"
};

chrome.runtime.onInstalled.addListener(async () => {
  await initializeRuntimeState();
});

chrome.runtime.onStartup.addListener(async () => {
  await cleanupStaleSessionState("前回のセッションを自動で終了しました。");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.recipient === "offscreen") {
    return undefined;
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || "不明なエラーが発生しました。"
      });
    });

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessionState = await getSessionState();
  if (sessionState.activeTabId === tabId) {
    await stopSession("対象タブが閉じられたため停止しました。");
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading") {
    return;
  }

  const sessionState = await getSessionState();
  if (sessionState.activeTabId === tabId) {
    await stopSession("ページ再読み込みを検知したため停止しました。");
  }
});

async function handleMessage(message) {
  switch (message.type) {
    case MESSAGE_TYPES.getState:
      return getPopupState();
    case MESSAGE_TYPES.startSession:
      return startSession(message);
    case MESSAGE_TYPES.stopSession:
      return stopSession("停止しました。");
    case MESSAGE_TYPES.settingsUpdated:
      return applySettings(message.settings);
    case MESSAGE_TYPES.overlayUpdated:
      return handleOverlayUpdated(message.overlayOffset);
    case MESSAGE_TYPES.partialTranscript:
    case MESSAGE_TYPES.finalTranscript:
    case MESSAGE_TYPES.finalTranslation:
    case MESSAGE_TYPES.sessionError:
    case MESSAGE_TYPES.sessionStatusChanged:
      return handleOffscreenEvent(message);
    default:
      return {};
  }
}

async function getPopupState() {
  const [storedSettings, sessionState, activeTab, runtimeLogs] = await Promise.all([
    getSettings(),
    getDisplaySessionState(),
    getActiveTab(),
    getRuntimeLogs()
  ]);
  const settings = normalizeSettings(storedSettings);
  const support = getTabSupport(activeTab?.url);

  return {
    settings,
    sessionState,
    runtimeLogs,
    support,
    activeTab: activeTab
      ? {
          id: activeTab.id,
          title: activeTab.title || "Current Tab",
          url: activeTab.url || ""
        }
      : null
  };
}

async function applySettings(inputSettings = {}) {
  const settings = await saveSettings(normalizeSettings(inputSettings));
  const sessionState = await getSessionState();

  if (sessionState.activeTabId != null) {
    const liveSessionPatch = buildLiveSessionSettingsPatch(settings, sessionState);
    await sendMessageToTab(sessionState.activeTabId, {
      type: MESSAGE_TYPES.settingsUpdated,
      settings: buildLiveContentSettingsPatch(settings, sessionState, liveSessionPatch)
    });

    if (await hasOffscreenDocument()) {
      try {
        await chrome.runtime.sendMessage({
          recipient: "offscreen",
          type: MESSAGE_TYPES.settingsUpdated,
          settings: liveSessionPatch
        });
      } catch {
        // ignore offscreen wake-up timing noise
      }
    }

    if (liveSessionPatch.sourceLang && liveSessionPatch.targetLang) {
      await setSessionState({
        ...sessionState,
        sourceLang: liveSessionPatch.sourceLang,
        targetLang: liveSessionPatch.targetLang
      });
    }
  }

  return { settings };
}

async function handleOverlayUpdated(overlayOffset) {
  const settings = await getSettings();
  const nextSettings = await saveSettings({
    ...settings,
    overlayOffset: normalizeOverlayOffset(overlayOffset)
  });

  return { settings: nextSettings };
}

async function startSession(input = {}) {
  await cleanupStaleSessionState();

  const settings = await saveSettings(normalizeSettings(input.settings || {}));
  validateSettings(settings);
  const runtimeSessionId = createRuntimeSessionId();

  const activeTab = input.tabId ? await chrome.tabs.get(input.tabId) : await getActiveTab();
  if (!activeTab?.id) {
    throw new Error("アクティブタブを取得できませんでした。");
  }

  debugLog("session:start", {
    tabId: activeTab.id,
    url: activeTab.url || "",
    sttProvider: settings.sttProvider,
    translationProvider: settings.translationProvider,
    geminiModel: settings.translationProvider === TRANSLATION_PROVIDERS.gemini ? settings.geminiModel : null,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    segmentationMode: settings.segmentationMode
  });

  const support = getTabSupport(activeTab.url);
  if (!support.supported) {
    throw new Error(support.reason);
  }

  const currentSession = await getSessionState();
  if ([SESSION_STATUS.active, SESSION_STATUS.starting, SESSION_STATUS.error].includes(currentSession.status)) {
    await stopSession("新しいセッションに切り替えました。");
  }

  await ensureContentLayer(activeTab.id);
  await sendMessageToTab(activeTab.id, {
    type: MESSAGE_TYPES.settingsUpdated,
    settings
  });

  await setSessionState({
    status: SESSION_STATUS.starting,
    activeTabId: activeTab.id,
    runtimeSessionId,
    sttProvider: settings.sttProvider,
    sttTransport: getSttTransport(settings),
    sttConnectionState: STT_CONNECTION_STATES.connecting,
    utteranceIndex: 0,
    translationProvider: settings.translationProvider,
    geminiModel: settings.translationProvider === TRANSLATION_PROVIDERS.gemini ? settings.geminiModel : null,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    message: getSessionStartingMessage(settings.sttProvider)
  });
  await sendMessageToTab(activeTab.id, {
    type: MESSAGE_TYPES.sessionStatusChanged,
    status: SESSION_STATUS.starting,
    message: getSessionStartingMessage(settings.sttProvider)
  });

  await waitForTabCaptureRelease(activeTab.id);

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
  } catch (error) {
    if (String(error?.message || "").includes("active stream")) {
      throw new Error("前回のタブキャプチャがまだ残っています。数秒待ってから再試行してください。");
    }

    throw error;
  }

  const response = await startOffscreenSession({
    tabId: activeTab.id,
    streamId,
    runtimeSessionId,
    settings
  });

  if (!response?.ok) {
    await setSessionState({
      status: SESSION_STATUS.error,
      activeTabId: activeTab.id,
      runtimeSessionId,
      sttProvider: settings.sttProvider,
      sttTransport: getSttTransport(settings),
      sttConnectionState: STT_CONNECTION_STATES.closed,
      utteranceIndex: 0,
      translationProvider: settings.translationProvider,
      geminiModel: settings.translationProvider === TRANSLATION_PROVIDERS.gemini ? settings.geminiModel : null,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      message: response?.error || "録音セッションの開始に失敗しました。"
    });
    throw new Error(response?.error || "録音セッションの開始に失敗しました。");
  }

  return {
    settings,
    sessionState: await getSessionState()
  };
}

async function stopSession(message = "停止しました。") {
  const sessionState = await getSessionState();
  const activeTabId = sessionState.activeTabId;
  const offscreenOpen = await hasOffscreenDocument();
  debugLog("session:stop", {
    activeTabId,
    status: sessionState.status,
    message,
    offscreenOpen
  });

  if (sessionState.status !== SESSION_STATUS.idle) {
    await setSessionState({
      status: SESSION_STATUS.stopping,
      activeTabId,
      runtimeSessionId: sessionState.runtimeSessionId || null,
      sttProvider: sessionState.sttProvider || null,
      translationProvider: sessionState.translationProvider || null,
      geminiModel: sessionState.geminiModel || null,
      sourceLang: sessionState.sourceLang || null,
      targetLang: sessionState.targetLang || null,
      message: "停止しています…"
    });
  }

  if (activeTabId == null && !offscreenOpen) {
    await setSessionState({
      ...IDLE_SESSION_STATE,
      message
    });
    return {
      sessionState: await getSessionState()
    };
  }

  if (activeTabId != null) {
    await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.clearOverlay
    });
  }

  if (offscreenOpen) {
    try {
      await chrome.runtime.sendMessage({
        recipient: "offscreen",
        type: MESSAGE_TYPES.stopSession
      });
    } catch {
      // ignore teardown noise
    }

    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // ignore already-closed state
    }
  }

  await setSessionState({
    ...IDLE_SESSION_STATE,
    message
  });

  if (activeTabId != null) {
    try {
      await waitForTabCaptureRelease(activeTabId, 2500);
    } catch {
      // ignore lingering release timeout; caller can retry
    }
  }

  return {
    sessionState: await getSessionState()
  };
}

async function handleOffscreenEvent(message) {
  const sessionState = await getSessionState();
  if (!isCurrentRuntimeSessionMessage(sessionState, message)) {
    debugLog("offscreen:event-stale", {
      type: message.type,
      activeTabId: sessionState.activeTabId,
      currentRuntimeSessionId: sessionState.runtimeSessionId || null,
      runtimeSessionId: message.runtimeSessionId || null
    });
    return {
      sessionState
    };
  }

  const activeTabId = sessionState.activeTabId;
  if ([MESSAGE_TYPES.sessionStatusChanged, MESSAGE_TYPES.sessionError].includes(message.type)) {
    debugLog("offscreen:event", {
      type: message.type,
      status: message.status || null,
      error: message.error || null,
      message: message.message || null,
      activeTabId
    });
  }

  if (message.type === MESSAGE_TYPES.finalTranscript) {
    debugLog("offscreen:final-transcript", {
      activeTabId,
      sequenceId: Number(message.sequenceId || 0),
      transcriptChars: String(message.transcript || "").length,
      utteranceIndex: Number(message.utteranceIndex ?? 0)
    });
  }

  if (message.type === MESSAGE_TYPES.finalTranslation) {
    debugLog("offscreen:final-translation", {
      activeTabId,
      sequenceId: Number(message.sequenceId || 0),
      translationChars: String(message.translation || "").length,
      isFinal: Boolean(message.isFinal)
    });
  }

  if (activeTabId != null && [
    MESSAGE_TYPES.partialTranscript,
    MESSAGE_TYPES.finalTranscript,
    MESSAGE_TYPES.finalTranslation,
    MESSAGE_TYPES.sessionError,
    MESSAGE_TYPES.sessionStatusChanged
  ].includes(message.type)) {
    await sendMessageToTab(activeTabId, message);
  }

  if (message.type === MESSAGE_TYPES.sessionStatusChanged) {
    await setSessionState({
      status: message.status,
      activeTabId,
      runtimeSessionId: sessionState.runtimeSessionId || null,
      sttProvider: sessionState.sttProvider || null,
      sttTransport: message.sttTransport || sessionState.sttTransport || null,
      sttConnectionState: message.sttConnectionState || sessionState.sttConnectionState || STT_CONNECTION_STATES.idle,
      utteranceIndex: Number(message.utteranceIndex ?? sessionState.utteranceIndex ?? 0),
      translationProvider: sessionState.translationProvider || null,
      geminiModel: sessionState.geminiModel || null,
      sourceLang: sessionState.sourceLang || null,
      targetLang: sessionState.targetLang || null,
      message: message.message
    });
  }

  if (message.type === MESSAGE_TYPES.sessionError) {
    await setSessionState({
      status: SESSION_STATUS.error,
      activeTabId,
      runtimeSessionId: sessionState.runtimeSessionId || null,
      sttProvider: sessionState.sttProvider || null,
      sttTransport: message.sttTransport || sessionState.sttTransport || null,
      sttConnectionState: STT_CONNECTION_STATES.closed,
      utteranceIndex: Number(message.utteranceIndex ?? sessionState.utteranceIndex ?? 0),
      translationProvider: sessionState.translationProvider || null,
      geminiModel: sessionState.geminiModel || null,
      sourceLang: sessionState.sourceLang || null,
      targetLang: sessionState.targetLang || null,
      message: message.error || "処理中にエラーが発生しました。"
    });
  }

  return {
    sessionState: await getSessionState()
  };
}

async function ensureContentLayer(tabId) {
  const isReady = await pingContentLayer(tabId);
  if (isReady) {
    return;
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"]
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });

  return contexts.length > 0;
}

async function initializeRuntimeState() {
  await saveSettings(normalizeSettings(await getSettings()));
  await cleanupStaleSessionState("停止中", { force: true });
}

async function getDisplaySessionState() {
  const sessionState = await getSessionState();
  if (sessionState.status === SESSION_STATUS.idle) {
    return sessionState;
  }

  const runtime = await getSessionRuntimeSnapshot(sessionState.activeTabId);
  if (!shouldCleanupStaleSession(sessionState, runtime)) {
    return sessionState;
  }

  return { ...IDLE_SESSION_STATE };
}

async function cleanupStaleSessionState(message = "停止中", { force = false } = {}) {
  const sessionState = await getSessionState();
  if (!force && sessionState.status === SESSION_STATUS.idle) {
    return sessionState;
  }

  const activeTabId = sessionState.activeTabId;
  const runtime = await getSessionRuntimeSnapshot(activeTabId);
  const shouldReset = shouldCleanupStaleSession(sessionState, runtime, { force });

  if (!shouldReset) {
    return sessionState;
  }

  debugLog("session:cleanup-stale", {
    force,
    activeTabId,
    status: sessionState.status,
    offscreenOpen: runtime.offscreenOpen,
    tabStillExists: runtime.tabStillExists
  });

  if (runtime.offscreenOpen) {
    try {
      await chrome.runtime.sendMessage({
        recipient: "offscreen",
        type: MESSAGE_TYPES.stopSession
      });
    } catch {
      // ignore stale offscreen teardown noise
    }

    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // ignore already-closed state
    }
  }

  if (activeTabId != null) {
    await sendMessageToTab(activeTabId, {
      type: MESSAGE_TYPES.clearOverlay
    });
  }

  await setSessionState({
    ...IDLE_SESSION_STATE,
    message
  });

  return getSessionState();
}

async function getSessionRuntimeSnapshot(activeTabId) {
  const [offscreenOpen, tabStillExists] = await Promise.all([
    hasOffscreenDocument(),
    activeTabId != null ? doesTabExist(activeTabId) : Promise.resolve(false)
  ]);

  return {
    offscreenOpen,
    tabStillExists
  };
}

function shouldCleanupStaleSession(sessionState, runtime, { force = false } = {}) {
  if (force) {
    return true;
  }

  if (sessionState.status === SESSION_STATUS.idle) {
    return false;
  }

  if (sessionState.activeTabId == null) {
    return true;
  }

  if (!runtime.tabStillExists) {
    return true;
  }

  // Offscreen document is the authoritative runtime for an active session.
  return !runtime.offscreenOpen;
}

function isCurrentRuntimeSessionMessage(sessionState, message) {
  if (message.runtimeSessionId == null) {
    return true;
  }

  return message.runtimeSessionId === sessionState.runtimeSessionId;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: OFFSCREEN_REASONS,
    justification: "Realtime tab-audio transcription and translation."
  });
}

async function startOffscreenSession(payload) {
  await ensureOffscreenDocument();

  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage({
        recipient: "offscreen",
        type: MESSAGE_TYPES.startSession,
        payload
      });
    } catch (error) {
      lastError = error;
      await sleep(120 * (attempt + 1));
    }
  }

  throw lastError || new Error("offscreen document に接続できませんでした。");
}

async function waitForTabCaptureRelease(tabId, timeoutMs = 1800) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const capturedTabs = await chrome.tabCapture.getCapturedTabs();
    const activeCapture = capturedTabs.find(
      (entry) => entry.tabId === tabId && (entry.status === "active" || entry.status === "pending")
    );

    if (!activeCapture) {
      return;
    }

    await sleep(150);
  }

  throw new Error("前回のタブキャプチャが解放されるまで待機中です。");
}

async function doesTabExist(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function sendMessageToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

async function pingContentLayer(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.contentPing
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function setSessionState(sessionState) {
  await saveSessionState(sessionState);
  await updateBadge(sessionState.status);
}

function createRuntimeSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function updateBadge(status) {
  const mapping = {
    [SESSION_STATUS.idle]: { text: "", color: "#4d4d4d" },
    [SESSION_STATUS.starting]: { text: "...", color: "#7bdebb" },
    [SESSION_STATUS.active]: { text: "ON", color: "#59c8a2" },
    [SESSION_STATUS.stopping]: { text: "...", color: "#7bdebb" },
    [SESSION_STATUS.error]: { text: "ERR", color: "#ff8c8c" }
  };

  const { text, color } = mapping[status] || mapping[SESSION_STATUS.idle];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

function validateSettings(settings) {
  if (settings.sttProvider === STT_PROVIDERS.deepgram && !settings.deepgramApiKey) {
    throw new Error("Deepgram API Key を入力してください。");
  }

  if (settings.sttProvider === STT_PROVIDERS.xai && !settings.xaiApiKey) {
    throw new Error("xAI API Key を入力してください。");
  }

  if (settings.translationProvider === TRANSLATION_PROVIDERS.cloudTranslation && !settings.cloudTranslationApiKey) {
    throw new Error("Cloud Translation API Key を入力してください。");
  }

  if (settings.translationProvider === TRANSLATION_PROVIDERS.gemini && !settings.geminiApiKey) {
    throw new Error("Gemini API Key を入力してください。");
  }

  const allowedPair = PRESET_LANGUAGE_PAIRS.some(
    (pair) => pair.sourceLang === settings.sourceLang && pair.targetLang === settings.targetLang
  );

  if (!allowedPair) {
    throw new Error("この言語ペアは現在サポートしていません。");
  }

  const supportedSourceLanguages =
    STT_PROVIDER_SOURCE_LANGUAGE_SUPPORT[settings.sttProvider] ||
    STT_PROVIDER_SOURCE_LANGUAGE_SUPPORT[DEFAULT_SETTINGS.sttProvider] ||
    [];
  if (!supportedSourceLanguages.includes(settings.sourceLang)) {
    if (settings.sttProvider === STT_PROVIDERS.xai && settings.sourceLang === "zh") {
      throw new Error("Grok / xAI STT は現在、中国語入力に対応していません。英語または日本語を選択してください。");
    }

    throw new Error("選択した音声認識プロバイダでは、この入力言語を利用できません。");
  }
}

function normalizeSettings(settings) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...settings,
    overlayOffset: normalizeOverlayOffset(settings.overlayOffset ?? DEFAULT_SETTINGS.overlayOffset)
  };

  const allowedTarget = PRESET_LANGUAGE_PAIRS.find((pair) => pair.sourceLang === merged.sourceLang)?.targetLang;
  if (!allowedTarget) {
    return { ...DEFAULT_SETTINGS };
  }

  if (merged.targetLang !== allowedTarget) {
    merged.targetLang = allowedTarget;
  }

  merged.overlayOpacity = Math.min(1, Math.max(0.1, Number(merged.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity)));
  merged.showSourcePreview = Boolean(merged.showSourcePreview);
  merged.segmentationMode = ["latency", "balanced", "natural"].includes(merged.segmentationMode)
    ? merged.segmentationMode
    : DEFAULT_SETTINGS.segmentationMode;
  merged.latencyPreference = ["fastest", "balanced", "stable"].includes(merged.latencyPreference)
    ? merged.latencyPreference
    : DEFAULT_SETTINGS.latencyPreference;
  merged.sttProvider = normalizeSttProvider(merged.sttProvider);
  merged.xaiSttMode = DEFAULT_SETTINGS.xaiSttMode;
  merged.translationProvider = Object.values(TRANSLATION_PROVIDERS).includes(merged.translationProvider)
    ? merged.translationProvider
    : DEFAULT_SETTINGS.translationProvider;
  merged.geminiModel = Object.values(GEMINI_MODELS).includes(merged.geminiModel)
    ? merged.geminiModel
    : DEFAULT_SETTINGS.geminiModel;

  return merged;
}

function buildLiveSessionSettingsPatch(settings, sessionState = {}) {
  const patch = {
    displayMode: settings.displayMode,
    segmentationMode: settings.segmentationMode,
    latencyPreference: settings.latencyPreference,
    showSourcePreview: settings.showSourcePreview,
    overlayOpacity: settings.overlayOpacity,
    overlayAnchor: settings.overlayAnchor,
    overlayOffset: settings.overlayOffset
  };

  if (shouldLivePatchSessionLanguages(settings, sessionState)) {
    patch.sourceLang = settings.sourceLang;
    patch.targetLang = settings.targetLang;
  }

  return patch;
}

function buildLiveContentSettingsPatch(settings, sessionState = {}, liveSessionPatch = buildLiveSessionSettingsPatch(settings, sessionState)) {
  const patch = { ...liveSessionPatch };

  if (!("sourceLang" in patch) && sessionState.sourceLang) {
    patch.sourceLang = sessionState.sourceLang;
  }

  if (!("targetLang" in patch) && sessionState.targetLang) {
    patch.targetLang = sessionState.targetLang;
  }

  return patch;
}

function shouldLivePatchSessionLanguages(settings, sessionState = {}) {
  const activeSttProvider = normalizeSttProvider(sessionState.sttProvider || settings.sttProvider);
  return activeSttProvider === normalizeSttProvider(settings.sttProvider);
}

function getSessionStartingMessage(sttProvider) {
  return normalizeSttProvider(sttProvider) === STT_PROVIDERS.xai
    ? "xAI 音声認識を準備しています…"
    : "Deepgram に接続しています…";
}

function normalizeOverlayOffset(offset = {}) {
  return {
    x: Number(offset.x || 0),
    y: Number(offset.y || 0)
  };
}

function getSttTransport(settings) {
  if (normalizeSttProvider(settings?.sttProvider) === STT_PROVIDERS.xai) {
    return STT_TRANSPORTS.https;
  }

  return STT_TRANSPORTS.websocket;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tab;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(event, details = {}) {
  runtimeLogger(event, details);
}
