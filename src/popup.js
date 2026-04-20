import {
  DEFAULT_SETTINGS,
  MESSAGE_TYPES,
  PRESET_LANGUAGE_PAIRS,
  SESSION_STATUS,
  STORAGE_KEYS,
  STT_PROVIDERS
} from "./constants.js";
import {
  DISPLAY_MODE_OPTIONS,
  GEMINI_MODEL_OPTIONS,
  LATENCY_PREFERENCE_OPTIONS,
  SEGMENTATION_MODE_OPTIONS,
  STT_PROVIDER_OPTIONS,
  TRANSLATION_PROVIDER_OPTIONS,
  buildLanguagePairValue,
  getActiveTabSummary,
  getPopupStatusModel,
  getSttCompatibilityHint,
  getSupportedLanguagePairsForSttProvider,
  parseLanguagePairValue
} from "./ui-copy.js";
import { clearRuntimeLogs, getRuntimeLogs } from "./storage.js";

const MAX_VISIBLE_RUNTIME_LOGS = 150;
const RUNTIME_LOG_MESSAGE_FIELDS = ["message", "text", "event", "title", "summary"];
const RUNTIME_LOG_TIMESTAMP_FIELDS = ["timestamp", "time", "createdAt", "at"];
const RUNTIME_LOG_LEVEL_FIELDS = ["level", "severity"];
const RUNTIME_LOG_SOURCE_FIELDS = ["scope", "source", "component", "channel", "logger"];
const RUNTIME_LOG_BASE_FIELDS = new Set([
  ...RUNTIME_LOG_MESSAGE_FIELDS,
  ...RUNTIME_LOG_TIMESTAMP_FIELDS,
  ...RUNTIME_LOG_LEVEL_FIELDS,
  ...RUNTIME_LOG_SOURCE_FIELDS
]);

const elements = {
  appRoot: document.querySelector("#appRoot"),
  statusCard: document.querySelector("#statusCard"),
  statusBadge: document.querySelector("#statusBadge"),
  statusPair: document.querySelector("#statusPair"),
  tabTitle: document.querySelector("#tabTitle"),
  tabMeta: document.querySelector("#tabMeta"),
  sttProvider: document.querySelector("#sttProvider"),
  sttCompatibilityHint: document.querySelector("#sttCompatibilityHint"),
  deepgramApiKeyField: document.querySelector("#deepgramApiKeyField"),
  translationProvider: document.querySelector("#translationProvider"),
  deepgramApiKey: document.querySelector("#deepgramApiKey"),
  xaiApiKeyField: document.querySelector("#xaiApiKeyField"),
  xaiApiKey: document.querySelector("#xaiApiKey"),
  cloudTranslationApiKey: document.querySelector("#cloudTranslationApiKey"),
  geminiApiKey: document.querySelector("#geminiApiKey"),
  geminiModel: document.querySelector("#geminiModel"),
  languagePair: document.querySelector("#languagePair"),
  displayMode: document.querySelector("#displayMode"),
  segmentationMode: document.querySelector("#segmentationMode"),
  latencyPreference: document.querySelector("#latencyPreference"),
  showSourcePreview: document.querySelector("#showSourcePreview"),
  overlayOpacity: document.querySelector("#overlayOpacity"),
  overlayOpacityValue: document.querySelector("#overlayOpacityValue"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  statusText: document.querySelector("#statusText"),
  hintText: document.querySelector("#hintText"),
  logCount: document.querySelector("#logCount"),
  logMeta: document.querySelector("#logMeta"),
  runtimeLogsOutput: document.querySelector("#runtimeLogsOutput"),
  copyLogsButton: document.querySelector("#copyLogsButton"),
  clearLogsButton: document.querySelector("#clearLogsButton")
};

let cachedState = {
  settings: { ...DEFAULT_SETTINGS },
  sessionState: {
    status: SESSION_STATUS.idle,
    activeTabId: null,
    sttProvider: null,
    sttTransport: null,
    sttConnectionState: "idle",
    utteranceIndex: 0,
    translationProvider: null,
    message: "停止中"
  },
  support: {
    supported: true,
    reason: ""
  },
  runtimeLogs: []
};
let sttCompatibilityNotice = "";
let runtimeLogActionMessage = "";
let runtimeLogActionTimerId = null;

initialize().catch((error) => {
  elements.statusText.textContent = "初期化に失敗しました";
  elements.hintText.textContent = error.message || "popup 初期化でエラーが発生しました。";
});

async function initialize() {
  populateLanguagePairOptions();
  populateOptions(elements.sttProvider, STT_PROVIDER_OPTIONS);
  populateOptions(elements.translationProvider, TRANSLATION_PROVIDER_OPTIONS);
  populateOptions(elements.geminiModel, GEMINI_MODEL_OPTIONS);
  populateOptions(elements.displayMode, DISPLAY_MODE_OPTIONS);
  populateOptions(elements.segmentationMode, SEGMENTATION_MODE_OPTIONS);
  populateOptions(elements.latencyPreference, LATENCY_PREFERENCE_OPTIONS);
  bindEvents();
  renderRuntimeLogs();
  await refreshState();
}

function bindEvents() {
  elements.overlayOpacity.addEventListener("input", () => {
    elements.overlayOpacityValue.textContent = Number(elements.overlayOpacity.value).toFixed(2);
  });

  elements.sttProvider.addEventListener("change", handleSttProviderChange);
  elements.translationProvider.addEventListener("change", handleTranslationProviderChange);
  elements.languagePair.addEventListener("change", handleLanguagePairChange);
  elements.displayMode.addEventListener("change", persistDraftSettings);
  elements.segmentationMode.addEventListener("change", persistDraftSettings);
  elements.latencyPreference.addEventListener("change", persistDraftSettings);
  elements.showSourcePreview.addEventListener("change", persistDraftSettings);
  elements.overlayOpacity.addEventListener("change", persistDraftSettings);
  elements.deepgramApiKey.addEventListener("change", persistDraftSettings);
  elements.xaiApiKey.addEventListener("change", persistDraftSettings);
  elements.cloudTranslationApiKey.addEventListener("change", persistDraftSettings);
  elements.geminiApiKey.addEventListener("change", persistDraftSettings);
  elements.geminiModel.addEventListener("change", persistDraftSettings);
  elements.startButton.addEventListener("click", handleStart);
  elements.stopButton.addEventListener("click", handleStop);
  elements.copyLogsButton.addEventListener("click", handleCopyLogs);
  elements.clearLogsButton.addEventListener("click", handleClearLogs);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes.settings?.newValue) {
      cachedState.settings = {
        ...DEFAULT_SETTINGS,
        ...changes.settings.newValue
      };
      renderForm(cachedState.settings);
      renderStatus();
    }

    if (changes.sessionState?.newValue) {
      cachedState.sessionState = changes.sessionState.newValue;
      renderStatus();
    }

    if (changes[STORAGE_KEYS.runtimeLogsBackground] || changes[STORAGE_KEYS.runtimeLogsOffscreen]) {
      void syncRuntimeLogs();
    }
  });  
}

async function refreshState() {
  const [response, runtimeLogs] = await Promise.all([
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.getState
    }),
    getRuntimeLogs()
  ]);

  cachedState.runtimeLogs = normalizeRuntimeLogs(runtimeLogs);
  renderRuntimeLogs();

  if (!response?.ok) {
    elements.statusText.textContent = "初期化に失敗しました";
    elements.hintText.textContent = response?.error || "状態を取得できませんでした。";
    return;
  }

  cachedState = {
    ...cachedState,
    settings: response.settings || DEFAULT_SETTINGS,
    sessionState: response.sessionState || cachedState.sessionState,
    support: response.support || cachedState.support,
    activeTab: response.activeTab || null
  };

  renderForm(cachedState.settings);
  renderStatus();
}

async function syncRuntimeLogs() {
  cachedState.runtimeLogs = normalizeRuntimeLogs(await getRuntimeLogs());
  renderRuntimeLogs();
}

function renderRuntimeLogs() {
  const totalCount = cachedState.runtimeLogs.length;
  const visibleLogs = cachedState.runtimeLogs.slice(-MAX_VISIBLE_RUNTIME_LOGS);
  const hasLogs = visibleLogs.length > 0;
  const lastTimestamp = visibleLogs.length > 0 ? getRuntimeLogTimestamp(visibleLogs[visibleLogs.length - 1]) : "";
  const metaParts = [];

  elements.logCount.textContent = `${totalCount}件`;
  elements.copyLogsButton.disabled = !hasLogs;
  elements.clearLogsButton.disabled = !hasLogs;

  if (!hasLogs) {
    elements.runtimeLogsOutput.textContent = "保存された runtime log はまだありません。";
    elements.logMeta.textContent = runtimeLogActionMessage || "保存された runtime log はまだありません。";
    return;
  }

  metaParts.push(
    totalCount > MAX_VISIBLE_RUNTIME_LOGS
      ? `${totalCount}件中 最新${visibleLogs.length}件を表示`
      : `${visibleLogs.length}件の runtime log`
  );

  if (lastTimestamp) {
    metaParts.push(`最終更新: ${lastTimestamp}`);
  }

  if (runtimeLogActionMessage) {
    metaParts.push(runtimeLogActionMessage);
  }

  elements.logMeta.textContent = metaParts.join(" / ");
  elements.runtimeLogsOutput.textContent = visibleLogs.map((entry) => formatRuntimeLogEntry(entry)).join("\n\n");
}

function renderForm(settings) {
  elements.appRoot.dataset.provider = settings.translationProvider || DEFAULT_SETTINGS.translationProvider;
  elements.sttProvider.value = settings.sttProvider || DEFAULT_SETTINGS.sttProvider;
  elements.translationProvider.value = settings.translationProvider || DEFAULT_SETTINGS.translationProvider;
  elements.deepgramApiKey.value = settings.deepgramApiKey || "";
  elements.xaiApiKey.value = settings.xaiApiKey || "";
  elements.cloudTranslationApiKey.value = settings.cloudTranslationApiKey || "";
  elements.geminiApiKey.value = settings.geminiApiKey || "";
  elements.geminiModel.value = settings.geminiModel || DEFAULT_SETTINGS.geminiModel;
  syncSttProviderFields(elements.sttProvider.value);
  const selectedPairValue = buildLanguagePairValue(settings.sourceLang, settings.targetLang);
  const resolvedPair = syncLanguagePairOptions(elements.sttProvider.value, selectedPairValue);
  sttCompatibilityNotice =
    buildLanguagePairValue(resolvedPair.sourceLang, resolvedPair.targetLang) !== selectedPairValue
      ? buildSttAdjustmentNotice(elements.sttProvider.value)
      : "";
  cachedState.settings = {
    ...cachedState.settings,
    ...settings,
    sttProvider: elements.sttProvider.value,
    sourceLang: resolvedPair.sourceLang,
    targetLang: resolvedPair.targetLang
  };
  renderSttCompatibilityHint(elements.sttProvider.value, resolvedPair.sourceLang);
  elements.displayMode.value = settings.displayMode;
  elements.segmentationMode.value = settings.segmentationMode;
  elements.latencyPreference.value = settings.latencyPreference || DEFAULT_SETTINGS.latencyPreference;
  elements.showSourcePreview.checked = Boolean(settings.showSourcePreview);
  elements.overlayOpacity.value = String(settings.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity);
  elements.overlayOpacityValue.textContent = Number(elements.overlayOpacity.value).toFixed(2);
}

async function handleSttProviderChange() {
  const previousPairValue = elements.languagePair.value;
  const sttProvider = elements.sttProvider.value || DEFAULT_SETTINGS.sttProvider;
  const resolvedPair = syncLanguagePairOptions(sttProvider, previousPairValue);
  syncSttProviderFields(sttProvider);
  sttCompatibilityNotice =
    buildLanguagePairValue(resolvedPair.sourceLang, resolvedPair.targetLang) !== previousPairValue
      ? buildSttAdjustmentNotice(sttProvider)
      : "";
  renderSttCompatibilityHint(sttProvider, resolvedPair.sourceLang);
  await persistDraftSettings();
}

async function handleTranslationProviderChange() {
  elements.appRoot.dataset.provider = elements.translationProvider.value || DEFAULT_SETTINGS.translationProvider;
  await persistDraftSettings();
}

async function handleLanguagePairChange() {
  sttCompatibilityNotice = "";
  renderSttCompatibilityHint(
    elements.sttProvider.value || DEFAULT_SETTINGS.sttProvider,
    parseLanguagePairValue(elements.languagePair.value).sourceLang
  );
  await persistDraftSettings();
}

function renderStatus() {
  const viewModel = getPopupStatusModel(cachedState);
  const tabSummary = getActiveTabSummary(cachedState.activeTab, cachedState.support);

  elements.statusCard.dataset.state = viewModel.state;
  elements.statusBadge.textContent = viewModel.badge;
  elements.statusPair.textContent = viewModel.pairLabel;
  elements.statusText.textContent = viewModel.title;
  elements.hintText.textContent = viewModel.hint;
  elements.tabTitle.textContent = tabSummary.title;
  elements.tabMeta.textContent = tabSummary.meta;
  elements.startButton.disabled =
    !cachedState.support.supported || cachedState.sessionState.status === SESSION_STATUS.starting;
  elements.stopButton.disabled = cachedState.sessionState.status === SESSION_STATUS.idle;
}

function populateLanguagePairOptions() {
  elements.languagePair.innerHTML = "";

  for (const pair of PRESET_LANGUAGE_PAIRS) {
    const node = document.createElement("option");
    node.value = buildLanguagePairValue(pair.sourceLang, pair.targetLang);
    node.textContent = pair.label;
    elements.languagePair.appendChild(node);
  }
}

function populateOptions(selectElement, options) {
  selectElement.innerHTML = "";

  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    selectElement.appendChild(node);
  }
}

async function handleStart() {
  const settings = await persistDraftSettings();
  if (!cachedState.activeTab?.id) {
    cachedState.sessionState = {
      ...cachedState.sessionState,
      status: SESSION_STATUS.error,
      message: "対象タブを取得できませんでした"
    };
    renderStatus();
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.startSession,
    settings,
    tabId: cachedState.activeTab.id
  });

  if (!response?.ok) {
    cachedState.sessionState = {
      ...cachedState.sessionState,
      status: SESSION_STATUS.error,
      message: response?.error || "開始処理でエラーが発生しました。"
    };
    renderStatus();
    return;
  }

  await refreshState();
}

async function handleStop() {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.stopSession
  });

  if (!response?.ok) {
    cachedState.sessionState = {
      ...cachedState.sessionState,
      status: SESSION_STATUS.error,
      message: response?.error || "停止処理でエラーが発生しました。"
    };
    renderStatus();
    return;
  }

  await refreshState();
}

async function handleCopyLogs() {
  if (cachedState.runtimeLogs.length === 0) {
    return;
  }

  try {
    await copyTextToClipboard(cachedState.runtimeLogs.map((entry) => formatRuntimeLogEntry(entry)).join("\n\n"));
    showRuntimeLogActionMessage("コピーしました");
  } catch (error) {
    showRuntimeLogActionMessage(error?.message || "コピーに失敗しました");
  }
}

async function handleClearLogs() {
  try {
    await clearRuntimeLogs();
    cachedState.runtimeLogs = [];
    showRuntimeLogActionMessage("log を消去しました");
    renderRuntimeLogs();
  } catch (error) {
    showRuntimeLogActionMessage(error?.message || "log の消去に失敗しました");
  }
}

async function persistDraftSettings() {
  const sttProvider = elements.sttProvider.value || DEFAULT_SETTINGS.sttProvider;
  const selectedPair = syncLanguagePairOptions(sttProvider, elements.languagePair.value);
  renderSttCompatibilityHint(sttProvider, selectedPair.sourceLang);
  const settings = {
    sttProvider,
    deepgramApiKey: elements.deepgramApiKey.value.trim(),
    xaiApiKey: elements.xaiApiKey.value.trim(),
    translationProvider: elements.translationProvider.value,
    cloudTranslationApiKey: elements.cloudTranslationApiKey.value.trim(),
    geminiApiKey: elements.geminiApiKey.value.trim(),
    geminiModel: elements.geminiModel.value,
    sourceLang: selectedPair.sourceLang,
    targetLang: selectedPair.targetLang,
    displayMode: elements.displayMode.value,
    segmentationMode: elements.segmentationMode.value,
    latencyPreference: elements.latencyPreference.value || DEFAULT_SETTINGS.latencyPreference,
    showSourcePreview: elements.showSourcePreview.checked,
    overlayOpacity: Number(elements.overlayOpacity.value),
    overlayOffset: cachedState.settings.overlayOffset || DEFAULT_SETTINGS.overlayOffset
  };

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.settingsUpdated,
    settings
  });

  if (response?.ok && response.settings) {
    cachedState.settings = response.settings;
    renderForm(cachedState.settings);
    renderStatus();
  }

  return cachedState.settings;
}

function syncSttProviderFields(sttProvider) {
  const activeProvider = sttProvider || DEFAULT_SETTINGS.sttProvider;
  elements.deepgramApiKeyField.hidden = activeProvider !== STT_PROVIDERS.deepgram;
  elements.xaiApiKeyField.hidden = activeProvider !== STT_PROVIDERS.xai;
}

function syncLanguagePairOptions(sttProvider, selectedValue) {
  const supportedPairs = getSupportedLanguagePairsForSttProvider(sttProvider);
  const supportedValues = new Set(
    supportedPairs.map((pair) => buildLanguagePairValue(pair.sourceLang, pair.targetLang))
  );

  for (const option of elements.languagePair.options) {
    option.disabled = !supportedValues.has(option.value);
  }

  const resolvedValue = supportedValues.has(selectedValue)
    ? selectedValue
    : supportedPairs.length > 0
      ? buildLanguagePairValue(supportedPairs[0].sourceLang, supportedPairs[0].targetLang)
      : buildLanguagePairValue(DEFAULT_SETTINGS.sourceLang, DEFAULT_SETTINGS.targetLang);
  elements.languagePair.value = resolvedValue;

  return parseLanguagePairValue(resolvedValue);
}

function renderSttCompatibilityHint(sttProvider, sourceLang) {
  const message = sttCompatibilityNotice || getSttCompatibilityHint(sttProvider, sourceLang);
  elements.sttCompatibilityHint.hidden = !message;
  elements.sttCompatibilityHint.textContent = message;
}

function buildSttAdjustmentNotice(sttProvider) {
  if (sttProvider === STT_PROVIDERS.xai) {
    return "Grok / xAI STT は現在、中国語入力に対応していないため、利用できる翻訳方向に切り替えました。";
  }

  return "";
}

function normalizeRuntimeLogs(runtimeLogs) {
  if (Array.isArray(runtimeLogs)) {
    return runtimeLogs;
  }

  if (Array.isArray(runtimeLogs?.entries)) {
    return runtimeLogs.entries;
  }

  return [];
}

function formatRuntimeLogEntry(entry) {
  if (typeof entry === "string") {
    return entry;
  }

  if (entry == null) {
    return "";
  }

  if (typeof entry !== "object") {
    return String(entry);
  }

  const timestamp = formatRuntimeLogTimestamp(pickFirstFieldValue(entry, RUNTIME_LOG_TIMESTAMP_FIELDS));
  const level = pickFirstFieldValue(entry, RUNTIME_LOG_LEVEL_FIELDS);
  const source = pickFirstFieldValue(entry, RUNTIME_LOG_SOURCE_FIELDS);
  const message = pickFirstFieldValue(entry, RUNTIME_LOG_MESSAGE_FIELDS);
  const header = [timestamp ? `[${timestamp}]` : "", level ? String(level).toUpperCase() : "", source, message]
    .filter(Boolean)
    .join(" ");
  const extra = Object.entries(entry).filter(([key, value]) => !RUNTIME_LOG_BASE_FIELDS.has(key) && value !== undefined);

  if (extra.length === 0) {
    return header || safeJsonStringify(entry);
  }

  return `${header || safeJsonStringify(entry)}\n${safeJsonStringify(Object.fromEntries(extra))}`;
}

function getRuntimeLogTimestamp(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  return formatRuntimeLogTimestamp(pickFirstFieldValue(entry, RUNTIME_LOG_TIMESTAMP_FIELDS));
}

function pickFirstFieldValue(entry, fieldNames) {
  for (const fieldName of fieldNames) {
    const value = entry[fieldName];

    if (value === undefined || value === null || value === "") {
      continue;
    }

    return String(value);
  }

  return "";
}

function formatRuntimeLogTimestamp(value) {
  if (!value) {
    return "";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return new Date(numericValue).toLocaleString("ja-JP", {
    hour12: false
  });
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function showRuntimeLogActionMessage(message) {
  runtimeLogActionMessage = message;
  window.clearTimeout(runtimeLogActionTimerId);
  renderRuntimeLogs();
  runtimeLogActionTimerId = window.setTimeout(() => {
    runtimeLogActionMessage = "";
    renderRuntimeLogs();
  }, 2200);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand("copy");

    if (!copied) {
      throw new Error("コピーに失敗しました");
    }
  } finally {
    textarea.remove();
  }
}
