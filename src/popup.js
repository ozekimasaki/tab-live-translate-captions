import {
  DEFAULT_SETTINGS,
  DISPLAY_MODES,
  MESSAGE_TYPES,
  PRESET_LANGUAGE_PAIRS,
  SEGMENTATION_MODES,
  SESSION_STATUS
} from "./constants.js";

const elements = {
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

let cachedState = {
  settings: { ...DEFAULT_SETTINGS },
  sessionState: {
    status: SESSION_STATUS.idle,
    activeTabId: null,
    message: "停止中"
  },
  support: {
    supported: true,
    reason: ""
  }
};

initialize().catch((error) => {
  elements.statusText.textContent = "初期化に失敗しました";
  elements.hintText.textContent = error.message || "popup 初期化でエラーが発生しました。";
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
    elements.statusText.textContent = "初期化に失敗しました";
    elements.hintText.textContent = response?.error || "状態を取得できませんでした。";
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
  elements.statusText.textContent = sessionState.message || "停止中";

  if (!support.supported && sessionState.status !== SESSION_STATUS.active) {
    elements.hintText.textContent = support.reason;
  } else if (sessionState.status === SESSION_STATUS.active) {
    elements.hintText.textContent = "現在のタブ音声を翻訳字幕として表示中です。";
  } else if (sessionState.status === SESSION_STATUS.error) {
    elements.hintText.textContent = "キー設定またはネットワーク接続を確認してください。";
  } else {
    elements.hintText.textContent = "開始すると現在のアクティブタブ音声を取得します。";
  }

  elements.startButton.disabled = !support.supported || sessionState.status === SESSION_STATUS.starting;
  elements.stopButton.disabled = sessionState.status === SESSION_STATUS.idle;
}

function populateDisplayModeOptions() {
  const options = [
    { value: DISPLAY_MODES.translationOnly, label: "翻訳のみ" },
    { value: DISPLAY_MODES.dual, label: "原文 + 翻訳" }
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
    elements.statusText.textContent = "開始に失敗しました";
    elements.hintText.textContent = "対象タブを取得できませんでした。";
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.startSession,
    settings,
    tabId: cachedState.activeTab.id
  });

  if (!response?.ok) {
    elements.statusText.textContent = "開始に失敗しました";
    elements.hintText.textContent = response?.error || "開始処理でエラーが発生しました。";
    return;
  }

  await refreshState();
}

async function handleStop() {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.stopSession
  });

  if (!response?.ok) {
    elements.statusText.textContent = "停止に失敗しました";
    elements.hintText.textContent = response?.error || "停止処理でエラーが発生しました。";
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
    ja: "日本語",
    zh: "简体中文"
  };

  return mapping[lang] || lang.toUpperCase();
}
