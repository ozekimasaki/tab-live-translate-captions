(() => {
  // src/constants.js
  var STORAGE_KEYS = {
    settings: "settings",
    sessionState: "sessionState"
  };
  var DISPLAY_MODES = {
    translationOnly: "translation-only",
    dual: "dual"
  };
  var SEGMENTATION_MODES = {
    latency: "latency",
    balanced: "balanced",
    natural: "natural"
  };
  var PRESET_LANGUAGE_PAIRS = [
    { sourceLang: "en", targetLang: "ja", label: "\u82F1\u8A9E \u2192 \u65E5\u672C\u8A9E" },
    { sourceLang: "zh", targetLang: "ja", label: "\u4E2D\u56FD\u8A9E \u2192 \u65E5\u672C\u8A9E" },
    { sourceLang: "ja", targetLang: "en", label: "\u65E5\u672C\u8A9E \u2192 \u82F1\u8A9E" }
  ];
  var DEFAULT_SETTINGS = {
    deepgramApiKey: "",
    geminiApiKey: "",
    sourceLang: "en",
    targetLang: "ja",
    displayMode: DISPLAY_MODES.translationOnly,
    segmentationMode: SEGMENTATION_MODES.balanced,
    showSourcePreview: false,
    overlayOpacity: 0.78,
    overlayAnchor: "bottom-center",
    overlayOffset: {
      x: 0,
      y: 0
    }
  };
  var SESSION_STATUS = {
    idle: "idle",
    starting: "starting",
    active: "active",
    stopping: "stopping",
    error: "error"
  };
  var MESSAGE_TYPES = {
    getState: "GET_STATE",
    startSession: "START_SESSION",
    stopSession: "STOP_SESSION",
    settingsUpdated: "SETTINGS_UPDATED",
    sessionStatusChanged: "SESSION_STATUS_CHANGED",
    partialTranscript: "PARTIAL_TRANSCRIPT",
    finalTranscript: "FINAL_TRANSCRIPT",
    finalTranslation: "FINAL_TRANSLATION",
    sessionError: "SESSION_ERROR",
    overlayUpdated: "OVERLAY_UPDATED",
    clearOverlay: "CLEAR_OVERLAY"
  };

  // src/page-support.js
  var BLOCKED_PROTOCOLS = [
    "chrome:",
    "chrome-extension:",
    "edge:",
    "about:",
    "view-source:",
    "moz-extension:"
  ];
  var BLOCKED_HOSTS = [
    "chromewebstore.google.com",
    "chrome.google.com"
  ];
  function getTabSupport(url) {
    if (!url) {
      return { supported: false, reason: "\u30BF\u30D6 URL \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002" };
    }
    try {
      const parsed = new URL(url);
      if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
        return { supported: false, reason: "\u3053\u306E\u30DA\u30FC\u30B8\u7A2E\u5225\u3067\u306F\u62E1\u5F35\u306E\u30AA\u30FC\u30D0\u30FC\u30EC\u30A4\u3092\u633F\u5165\u3067\u304D\u307E\u305B\u3093\u3002" };
      }
      if (BLOCKED_HOSTS.includes(parsed.hostname)) {
        return { supported: false, reason: "Chrome Web Store \u4E0A\u3067\u306F\u958B\u59CB\u3067\u304D\u307E\u305B\u3093\u3002" };
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { supported: false, reason: "http/https \u30DA\u30FC\u30B8\u306E\u307F\u5BFE\u5FDC\u3057\u3066\u3044\u307E\u3059\u3002" };
      }
      return { supported: true, reason: "" };
    } catch {
      return { supported: false, reason: "\u3053\u306E\u30DA\u30FC\u30B8\u3067\u306F\u958B\u59CB\u3067\u304D\u307E\u305B\u3093\u3002" };
    }
  }

  // src/storage.js
  async function getSettings() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
    return {
      ...DEFAULT_SETTINGS,
      ...result[STORAGE_KEYS.settings] || {}
    };
  }
  async function saveSettings(settings) {
    const nextSettings = {
      ...DEFAULT_SETTINGS,
      ...settings
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: nextSettings
    });
    return nextSettings;
  }
  async function getSessionState() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.sessionState);
    return result[STORAGE_KEYS.sessionState] || {
      status: SESSION_STATUS.idle,
      activeTabId: null,
      message: "\u505C\u6B62\u4E2D"
    };
  }
  async function saveSessionState(sessionState) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.sessionState]: sessionState
    });
    return sessionState;
  }

  // src/background.js
  var OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
  var OFFSCREEN_REASONS = ["USER_MEDIA"];
  chrome.runtime.onInstalled.addListener(async () => {
    await saveSettings(await getSettings());
    await setSessionState({
      status: SESSION_STATUS.idle,
      activeTabId: null,
      message: "\u505C\u6B62\u4E2D"
    });
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.recipient === "offscreen") {
      return void 0;
    }
    handleMessage(message, sender).then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || "\u4E0D\u660E\u306A\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002"
      });
    });
    return true;
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const sessionState = await getSessionState();
    if (sessionState.activeTabId === tabId) {
      await stopSession("\u5BFE\u8C61\u30BF\u30D6\u304C\u9589\u3058\u3089\u308C\u305F\u305F\u3081\u505C\u6B62\u3057\u307E\u3057\u305F\u3002");
    }
  });
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== "loading") {
      return;
    }
    const sessionState = await getSessionState();
    if (sessionState.activeTabId === tabId) {
      await stopSession("\u30DA\u30FC\u30B8\u518D\u8AAD\u307F\u8FBC\u307F\u3092\u691C\u77E5\u3057\u305F\u305F\u3081\u505C\u6B62\u3057\u307E\u3057\u305F\u3002");
    }
  });
  async function handleMessage(message) {
    switch (message.type) {
      case MESSAGE_TYPES.getState:
        return getPopupState();
      case MESSAGE_TYPES.startSession:
        return startSession(message);
      case MESSAGE_TYPES.stopSession:
        return stopSession("\u505C\u6B62\u3057\u307E\u3057\u305F\u3002");
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
    const settings = await getSettings();
    const sessionState = await getSessionState();
    const activeTab = await getActiveTab();
    const support = getTabSupport(activeTab?.url);
    return {
      settings,
      sessionState,
      support,
      activeTab: activeTab ? {
        id: activeTab.id,
        title: activeTab.title || "Current Tab",
        url: activeTab.url || ""
      } : null
    };
  }
  async function applySettings(inputSettings = {}) {
    const settings = await saveSettings(normalizeSettings(inputSettings));
    const sessionState = await getSessionState();
    if (sessionState.activeTabId != null) {
      await sendMessageToTab(sessionState.activeTabId, {
        type: MESSAGE_TYPES.settingsUpdated,
        settings
      });
      if (await hasOffscreenDocument()) {
        try {
          await chrome.runtime.sendMessage({
            recipient: "offscreen",
            type: MESSAGE_TYPES.settingsUpdated,
            settings
          });
        } catch {
        }
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
    const settings = await saveSettings(normalizeSettings(input.settings || {}));
    validateSettings(settings);
    const activeTab = input.tabId ? await chrome.tabs.get(input.tabId) : await getActiveTab();
    if (!activeTab?.id) {
      throw new Error("\u30A2\u30AF\u30C6\u30A3\u30D6\u30BF\u30D6\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
    }
    const support = getTabSupport(activeTab.url);
    if (!support.supported) {
      throw new Error(support.reason);
    }
    const currentSession = await getSessionState();
    if ([SESSION_STATUS.active, SESSION_STATUS.starting, SESSION_STATUS.error].includes(currentSession.status)) {
      await stopSession("\u65B0\u3057\u3044\u30BB\u30C3\u30B7\u30E7\u30F3\u306B\u5207\u308A\u66FF\u3048\u307E\u3057\u305F\u3002");
    }
    await ensureContentLayer(activeTab.id);
    await sendMessageToTab(activeTab.id, {
      type: MESSAGE_TYPES.settingsUpdated,
      settings
    });
    await setSessionState({
      status: SESSION_STATUS.starting,
      activeTabId: activeTab.id,
      message: "\u63A5\u7D9A\u3092\u958B\u59CB\u3057\u3066\u3044\u307E\u3059\u2026"
    });
    await sendMessageToTab(activeTab.id, {
      type: MESSAGE_TYPES.sessionStatusChanged,
      status: SESSION_STATUS.starting,
      message: "\u63A5\u7D9A\u3092\u958B\u59CB\u3057\u3066\u3044\u307E\u3059\u2026"
    });
    await waitForTabCaptureRelease(activeTab.id);
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    } catch (error) {
      if (String(error?.message || "").includes("active stream")) {
        throw new Error("\u524D\u56DE\u306E\u30BF\u30D6\u30AD\u30E3\u30D7\u30C1\u30E3\u304C\u307E\u3060\u6B8B\u3063\u3066\u3044\u307E\u3059\u3002\u6570\u79D2\u5F85\u3063\u3066\u304B\u3089\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      }
      throw error;
    }
    const response = await startOffscreenSession({
      tabId: activeTab.id,
      streamId,
      settings
    });
    if (!response?.ok) {
      await setSessionState({
        status: SESSION_STATUS.error,
        activeTabId: activeTab.id,
        message: response?.error || "\u9332\u97F3\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u958B\u59CB\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002"
      });
      throw new Error(response?.error || "\u9332\u97F3\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u958B\u59CB\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002");
    }
    return {
      settings,
      sessionState: await getSessionState()
    };
  }
  async function stopSession(message = "\u505C\u6B62\u3057\u307E\u3057\u305F\u3002") {
    const sessionState = await getSessionState();
    const activeTabId = sessionState.activeTabId;
    if (activeTabId != null) {
      await sendMessageToTab(activeTabId, {
        type: MESSAGE_TYPES.clearOverlay
      });
    }
    if (await hasOffscreenDocument()) {
      try {
        await chrome.runtime.sendMessage({
          recipient: "offscreen",
          type: MESSAGE_TYPES.stopSession
        });
      } catch {
      }
      try {
        await chrome.offscreen.closeDocument();
      } catch {
      }
    }
    await setSessionState({
      status: SESSION_STATUS.idle,
      activeTabId: null,
      message
    });
    if (activeTabId != null) {
      try {
        await waitForTabCaptureRelease(activeTabId, 2500);
      } catch {
      }
    }
    return {
      sessionState: await getSessionState()
    };
  }
  async function handleOffscreenEvent(message) {
    const sessionState = await getSessionState();
    const activeTabId = sessionState.activeTabId;
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
        message: message.message
      });
    }
    if (message.type === MESSAGE_TYPES.sessionError) {
      await setSessionState({
        status: SESSION_STATUS.error,
        activeTabId,
        message: message.error || "\u51E6\u7406\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002"
      });
    }
    return {
      sessionState: await getSessionState()
    };
  }
  async function ensureContentLayer(tabId) {
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
    throw lastError || new Error("offscreen document \u306B\u63A5\u7D9A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002");
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
    throw new Error("\u524D\u56DE\u306E\u30BF\u30D6\u30AD\u30E3\u30D7\u30C1\u30E3\u304C\u89E3\u653E\u3055\u308C\u308B\u307E\u3067\u5F85\u6A5F\u4E2D\u3067\u3059\u3002");
  }
  async function sendMessageToTab(tabId, message) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch {
      return false;
    }
  }
  async function setSessionState(sessionState) {
    await saveSessionState(sessionState);
    await updateBadge(sessionState.status);
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
    if (!settings.deepgramApiKey) {
      throw new Error("Deepgram API Key \u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    }
    if (!settings.geminiApiKey) {
      throw new Error("Gemini API Key \u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    }
    const allowedPair = PRESET_LANGUAGE_PAIRS.some(
      (pair) => pair.sourceLang === settings.sourceLang && pair.targetLang === settings.targetLang
    );
    if (!allowedPair) {
      throw new Error("\u3053\u306E\u8A00\u8A9E\u30DA\u30A2\u306F\u73FE\u5728\u30B5\u30DD\u30FC\u30C8\u3057\u3066\u3044\u307E\u305B\u3093\u3002");
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
    merged.segmentationMode = ["latency", "balanced", "natural"].includes(merged.segmentationMode) ? merged.segmentationMode : DEFAULT_SETTINGS.segmentationMode;
    return merged;
  }
  function normalizeOverlayOffset(offset = {}) {
    return {
      x: Number(offset.x || 0),
      y: Number(offset.y || 0)
    };
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
})();
