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
    { sourceLang: "en", targetLang: "ja", label: "English -> \u65E5\u672C\u8A9E" },
    { sourceLang: "zh", targetLang: "ja", label: "\u4E2D\u6587 -> \u65E5\u672C\u8A9E" },
    { sourceLang: "ja", targetLang: "en", label: "\u65E5\u672C\u8A9E -> English" }
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

  // src/popup.js
  var elements = {
    deepgramApiKey: document.querySelector("#deepgramApiKey"),
    geminiApiKey: document.querySelector("#geminiApiKey"),
    sourceLang: document.querySelector("#sourceLang"),
    targetLang: document.querySelector("#targetLang"),
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
    populateDisplayModeOptions();
    populateSegmentationModeOptions();
    populateSourceOptions();
    elements.overlayOpacity.addEventListener("input", () => {
      elements.overlayOpacityValue.textContent = Number(elements.overlayOpacity.value).toFixed(2);
    });
    elements.sourceLang.addEventListener("change", async () => {
      populateTargetOptions(elements.sourceLang.value);
      await persistDraftSettings();
    });
    elements.targetLang.addEventListener("change", persistDraftSettings);
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
    await refreshState();
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
    elements.sourceLang.value = settings.sourceLang;
    populateTargetOptions(settings.sourceLang, settings.targetLang);
    elements.displayMode.value = settings.displayMode || DISPLAY_MODES.translationOnly;
    elements.segmentationMode.value = settings.segmentationMode || SEGMENTATION_MODES.balanced;
    elements.showSourcePreview.checked = Boolean(settings.showSourcePreview);
    elements.overlayOpacity.value = String(settings.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity);
    elements.overlayOpacityValue.textContent = Number(elements.overlayOpacity.value).toFixed(2);
  }
  function renderStatus() {
    const { sessionState, support } = cachedState;
    elements.statusText.textContent = sessionState.message || "\u505C\u6B62\u4E2D";
    if (!support.supported && sessionState.status !== SESSION_STATUS.active) {
      elements.hintText.textContent = support.reason;
    } else if (sessionState.status === SESSION_STATUS.active) {
      elements.hintText.textContent = "\u73FE\u5728\u306E\u30BF\u30D6\u97F3\u58F0\u3092\u7FFB\u8A33\u5B57\u5E55\u3068\u3057\u3066\u8868\u793A\u4E2D\u3067\u3059\u3002";
    } else if (sessionState.status === SESSION_STATUS.error) {
      elements.hintText.textContent = "\u30AD\u30FC\u8A2D\u5B9A\u307E\u305F\u306F\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u63A5\u7D9A\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
    } else {
      elements.hintText.textContent = "\u958B\u59CB\u3059\u308B\u3068\u73FE\u5728\u306E\u30A2\u30AF\u30C6\u30A3\u30D6\u30BF\u30D6\u97F3\u58F0\u3092\u53D6\u5F97\u3057\u307E\u3059\u3002";
    }
    elements.startButton.disabled = !support.supported || sessionState.status === SESSION_STATUS.starting;
    elements.stopButton.disabled = sessionState.status === SESSION_STATUS.idle;
  }
  function populateDisplayModeOptions() {
    const options = [
      { value: DISPLAY_MODES.translationOnly, label: "\u7FFB\u8A33\u306E\u307F" },
      { value: DISPLAY_MODES.dual, label: "\u539F\u6587 + \u7FFB\u8A33" }
    ];
    elements.displayMode.innerHTML = "";
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      elements.displayMode.appendChild(node);
    }
  }
  function populateSegmentationModeOptions() {
    const options = [
      { value: SEGMENTATION_MODES.latency, label: "Low Latency" },
      { value: SEGMENTATION_MODES.balanced, label: "Balanced" },
      { value: SEGMENTATION_MODES.natural, label: "Natural" }
    ];
    elements.segmentationMode.innerHTML = "";
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      elements.segmentationMode.appendChild(node);
    }
  }
  function populateSourceOptions() {
    const uniqueSources = Array.from(new Set(PRESET_LANGUAGE_PAIRS.map((pair) => pair.sourceLang)));
    elements.sourceLang.innerHTML = "";
    for (const sourceLang of uniqueSources) {
      const node = document.createElement("option");
      node.value = sourceLang;
      node.textContent = labelForLanguage(sourceLang);
      elements.sourceLang.appendChild(node);
    }
  }
  function populateTargetOptions(sourceLang, targetLang) {
    const pair = PRESET_LANGUAGE_PAIRS.find((item) => item.sourceLang === sourceLang) || PRESET_LANGUAGE_PAIRS[0];
    elements.targetLang.innerHTML = "";
    const node = document.createElement("option");
    node.value = pair.targetLang;
    node.textContent = labelForLanguage(pair.targetLang);
    elements.targetLang.appendChild(node);
    elements.targetLang.value = targetLang === pair.targetLang ? targetLang : pair.targetLang;
  }
  async function handleStart() {
    const settings = await persistDraftSettings();
    if (!cachedState.activeTab?.id) {
      elements.statusText.textContent = "\u958B\u59CB\u306B\u5931\u6557\u3057\u307E\u3057\u305F";
      elements.hintText.textContent = "\u5BFE\u8C61\u30BF\u30D6\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002";
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.startSession,
      settings,
      tabId: cachedState.activeTab.id
    });
    if (!response?.ok) {
      elements.statusText.textContent = "\u958B\u59CB\u306B\u5931\u6557\u3057\u307E\u3057\u305F";
      elements.hintText.textContent = response?.error || "\u958B\u59CB\u51E6\u7406\u3067\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002";
      return;
    }
    await refreshState();
  }
  async function handleStop() {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.stopSession
    });
    if (!response?.ok) {
      elements.statusText.textContent = "\u505C\u6B62\u306B\u5931\u6557\u3057\u307E\u3057\u305F";
      elements.hintText.textContent = response?.error || "\u505C\u6B62\u51E6\u7406\u3067\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002";
      return;
    }
    await refreshState();
  }
  async function persistDraftSettings() {
    const settings = {
      deepgramApiKey: elements.deepgramApiKey.value.trim(),
      geminiApiKey: elements.geminiApiKey.value.trim(),
      sourceLang: elements.sourceLang.value,
      targetLang: elements.targetLang.value,
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
    }
    return cachedState.settings;
  }
  function labelForLanguage(lang) {
    const mapping = {
      en: "English",
      ja: "\u65E5\u672C\u8A9E",
      zh: "\u7B80\u4F53\u4E2D\u6587"
    };
    return mapping[lang] || lang.toUpperCase();
  }
})();
