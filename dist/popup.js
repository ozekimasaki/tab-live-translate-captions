(() => {
  // src/constants.js
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

  // src/ui-copy.js
  var LANGUAGE_LABELS = {
    en: "\u82F1\u8A9E",
    ja: "\u65E5\u672C\u8A9E",
    zh: "\u4E2D\u56FD\u8A9E"
  };
  var DISPLAY_MODE_OPTIONS = [
    {
      value: DISPLAY_MODES.translationOnly,
      label: "\u7FFB\u8A33\u306E\u307F",
      description: "\u7FFB\u8A33\u5B57\u5E55\u3060\u3051\u3092\u5927\u304D\u304F\u8868\u793A"
    },
    {
      value: DISPLAY_MODES.dual,
      label: "\u539F\u6587 + \u7FFB\u8A33",
      description: "\u539F\u6587\u3092\u88DC\u52A9\u8868\u793A\u3057\u3066\u78BA\u8A8D\u3057\u3084\u3059\u304F\u3059\u308B"
    }
  ];
  var SEGMENTATION_MODE_OPTIONS = [
    {
      value: SEGMENTATION_MODES.latency,
      label: "\u4F4E\u9045\u5EF6",
      description: "\u5B57\u5E55\u3092\u901F\u3081\u306B\u51FA\u3059"
    },
    {
      value: SEGMENTATION_MODES.balanced,
      label: "\u6A19\u6E96",
      description: "\u901F\u3055\u3068\u8AAD\u307F\u3084\u3059\u3055\u306E\u30D0\u30E9\u30F3\u30B9"
    },
    {
      value: SEGMENTATION_MODES.natural,
      label: "\u81EA\u7136",
      description: "\u307E\u3068\u307E\u308A\u3092\u512A\u5148\u3057\u3066\u8868\u793A"
    }
  ];
  function getLanguageLabel(language) {
    return LANGUAGE_LABELS[language] || String(language || "").toUpperCase();
  }
  function buildLanguagePairValue(sourceLang, targetLang) {
    return `${sourceLang}:${targetLang}`;
  }
  function parseLanguagePairValue(value) {
    const [sourceLang, targetLang] = String(value || "").split(":");
    return PRESET_LANGUAGE_PAIRS.find((pair) => pair.sourceLang === sourceLang && pair.targetLang === targetLang) || PRESET_LANGUAGE_PAIRS[0];
  }
  function getLanguagePairLabel(sourceLang, targetLang) {
    return `${getLanguageLabel(sourceLang)} \u2192 ${getLanguageLabel(targetLang)}`;
  }
  function getPopupStatusModel({ settings, sessionState, support }) {
    const pairLabel = getLanguagePairLabel(settings.sourceLang, settings.targetLang);
    if (!support.supported && sessionState.status !== SESSION_STATUS.active) {
      return {
        state: "unsupported",
        badge: "\u975E\u5BFE\u5FDC",
        title: "\u3053\u306E\u30DA\u30FC\u30B8\u3067\u306F\u958B\u59CB\u3067\u304D\u307E\u305B\u3093",
        hint: support.reason,
        pairLabel
      };
    }
    switch (sessionState.status) {
      case SESSION_STATUS.starting:
        return {
          state: "starting",
          badge: "\u63A5\u7D9A\u4E2D",
          title: sessionState.message || "\u97F3\u58F0\u51E6\u7406\u3092\u958B\u59CB\u3057\u3066\u3044\u307E\u3059",
          hint: "\u6700\u521D\u306E\u5B57\u5E55\u304C\u8868\u793A\u3055\u308C\u308B\u307E\u3067\u6570\u79D2\u304B\u304B\u308B\u3053\u3068\u304C\u3042\u308A\u307E\u3059\u3002",
          pairLabel
        };
      case SESSION_STATUS.active:
        return {
          state: "active",
          badge: "\u5B57\u5E55\u4E2D",
          title: sessionState.message || "\u7FFB\u8A33\u5B57\u5E55\u3092\u8868\u793A\u3057\u3066\u3044\u307E\u3059",
          hint: "\u30DA\u30FC\u30B8\u4E0B\u90E8\u306E\u5B57\u5E55\u30D0\u30FC\u306F\u30C9\u30E9\u30C3\u30B0\u79FB\u52D5\u3067\u304D\u307E\u3059\u3002",
          pairLabel
        };
      case SESSION_STATUS.error:
        return {
          state: "error",
          badge: "\u8981\u78BA\u8A8D",
          title: sessionState.message || "\u51E6\u7406\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F",
          hint: "API \u30AD\u30FC\u3001\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u3001\u5BFE\u8C61\u30BF\u30D6\u306E\u97F3\u58F0\u51FA\u529B\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
          pairLabel
        };
      default:
        return {
          state: "idle",
          badge: "\u5F85\u6A5F\u4E2D",
          title: "\u958B\u59CB\u3059\u308B\u3068\u73FE\u5728\u306E\u30BF\u30D6\u97F3\u58F0\u3092\u53D6\u5F97\u3057\u307E\u3059",
          hint: "\u901A\u5E38\u306E Web \u30DA\u30FC\u30B8\u3067\u4F7F\u3048\u307E\u3059\u3002\u5B57\u5E55\u30D0\u30FC\u306F\u900F\u904E\u3084\u8868\u793A\u30E2\u30FC\u30C9\u3092\u5909\u66F4\u3067\u304D\u307E\u3059\u3002",
          pairLabel
        };
    }
  }
  function getActiveTabSummary(activeTab, support) {
    if (!activeTab?.id) {
      return {
        title: "\u5BFE\u8C61\u30BF\u30D6\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093",
        meta: "\u5B57\u5E55\u3092\u51FA\u3057\u305F\u3044\u30DA\u30FC\u30B8\u3092\u524D\u9762\u306B\u3057\u3066\u304B\u3089\u958B\u3044\u3066\u304F\u3060\u3055\u3044\u3002"
      };
    }
    const hostname = getHostname(activeTab.url);
    const title = compactText(activeTab.title || hostname || "\u73FE\u5728\u306E\u30BF\u30D6", 48);
    if (!support.supported) {
      return {
        title,
        meta: support.reason
      };
    }
    return {
      title,
      meta: hostname || "\u901A\u5E38\u306E Web \u30DA\u30FC\u30B8"
    };
  }
  function getHostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }
  function compactText(text, maxLength) {
    const value = String(text || "").trim();
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 1)}\u2026`;
  }

  // src/popup.js
  var elements = {
    statusCard: document.querySelector("#statusCard"),
    statusBadge: document.querySelector("#statusBadge"),
    statusPair: document.querySelector("#statusPair"),
    tabTitle: document.querySelector("#tabTitle"),
    tabMeta: document.querySelector("#tabMeta"),
    deepgramApiKey: document.querySelector("#deepgramApiKey"),
    geminiApiKey: document.querySelector("#geminiApiKey"),
    languagePair: document.querySelector("#languagePair"),
    displayMode: document.querySelector("#displayMode"),
    segmentationMode: document.querySelector("#segmentationMode"),
    showSourcePreview: document.querySelector("#showSourcePreview"),
    overlayOpacity: document.querySelector("#overlayOpacity"),
    overlayOpacityValue: document.querySelector("#overlayOpacityValue"),
    startButton: document.querySelector("#startButton"),
    stopButton: document.querySelector("#stopButton"),
    statusText: document.querySelector("#statusText"),
    hintText: document.querySelector("#hintText")
  };
  var cachedState = {
    settings: { ...DEFAULT_SETTINGS },
    sessionState: {
      status: SESSION_STATUS.idle,
      activeTabId: null,
      message: "\u505C\u6B62\u4E2D"
    },
    support: {
      supported: true,
      reason: ""
    }
  };
  initialize().catch((error) => {
    elements.statusText.textContent = "\u521D\u671F\u5316\u306B\u5931\u6557\u3057\u307E\u3057\u305F";
    elements.hintText.textContent = error.message || "popup \u521D\u671F\u5316\u3067\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002";
  });
  async function initialize() {
    populateLanguagePairOptions();
    populateOptions(elements.displayMode, DISPLAY_MODE_OPTIONS);
    populateOptions(elements.segmentationMode, SEGMENTATION_MODE_OPTIONS);
    bindEvents();
    await refreshState();
  }
  function bindEvents() {
    elements.overlayOpacity.addEventListener("input", () => {
      elements.overlayOpacityValue.textContent = Number(elements.overlayOpacity.value).toFixed(2);
    });
    elements.languagePair.addEventListener("change", persistDraftSettings);
    elements.displayMode.addEventListener("change", persistDraftSettings);
    elements.segmentationMode.addEventListener("change", persistDraftSettings);
    elements.showSourcePreview.addEventListener("change", persistDraftSettings);
    elements.overlayOpacity.addEventListener("change", persistDraftSettings);
    elements.deepgramApiKey.addEventListener("change", persistDraftSettings);
    elements.geminiApiKey.addEventListener("change", persistDraftSettings);
    elements.startButton.addEventListener("click", handleStart);
    elements.stopButton.addEventListener("click", handleStop);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (changes.sessionState?.newValue) {
        cachedState.sessionState = changes.sessionState.newValue;
        renderStatus();
      }
    });
  }
  async function refreshState() {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.getState
    });
    if (!response?.ok) {
      elements.statusText.textContent = "\u521D\u671F\u5316\u306B\u5931\u6557\u3057\u307E\u3057\u305F";
      elements.hintText.textContent = response?.error || "\u72B6\u614B\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002";
      return;
    }
    cachedState = {
      settings: response.settings || DEFAULT_SETTINGS,
      sessionState: response.sessionState || cachedState.sessionState,
      support: response.support || cachedState.support,
      activeTab: response.activeTab || null
    };
    renderForm(cachedState.settings);
    renderStatus();
  }
  function renderForm(settings) {
    elements.deepgramApiKey.value = settings.deepgramApiKey || "";
    elements.geminiApiKey.value = settings.geminiApiKey || "";
    elements.languagePair.value = buildLanguagePairValue(settings.sourceLang, settings.targetLang);
    elements.displayMode.value = settings.displayMode;
    elements.segmentationMode.value = settings.segmentationMode;
    elements.showSourcePreview.checked = Boolean(settings.showSourcePreview);
    elements.overlayOpacity.value = String(settings.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity);
    elements.overlayOpacityValue.textContent = Number(elements.overlayOpacity.value).toFixed(2);
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
    elements.startButton.disabled = !cachedState.support.supported || cachedState.sessionState.status === SESSION_STATUS.starting;
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
        message: "\u5BFE\u8C61\u30BF\u30D6\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F"
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
        message: response?.error || "\u958B\u59CB\u51E6\u7406\u3067\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002"
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
        message: response?.error || "\u505C\u6B62\u51E6\u7406\u3067\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002"
      };
      renderStatus();
      return;
    }
    await refreshState();
  }
  async function persistDraftSettings() {
    const selectedPair = parseLanguagePairValue(elements.languagePair.value);
    const settings = {
      deepgramApiKey: elements.deepgramApiKey.value.trim(),
      geminiApiKey: elements.geminiApiKey.value.trim(),
      sourceLang: selectedPair.sourceLang,
      targetLang: selectedPair.targetLang,
      displayMode: elements.displayMode.value,
      segmentationMode: elements.segmentationMode.value,
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
})();
