import {
  DEFAULT_SETTINGS,
  MESSAGE_TYPES,
  PRESET_LANGUAGE_PAIRS,
  SESSION_STATUS
} from "./constants.js";
import {
  DISPLAY_MODE_OPTIONS,
  GEMINI_MODEL_OPTIONS,
  SEGMENTATION_MODE_OPTIONS,
  TRANSLATION_PROVIDER_OPTIONS,
  buildLanguagePairValue,
  getActiveTabSummary,
  getPopupStatusModel,
  parseLanguagePairValue
} from "./ui-copy.js";

const elements = {
  appRoot: document.querySelector("#appRoot"),
  statusCard: document.querySelector("#statusCard"),
  statusBadge: document.querySelector("#statusBadge"),
  statusPair: document.querySelector("#statusPair"),
  tabTitle: document.querySelector("#tabTitle"),
  tabMeta: document.querySelector("#tabMeta"),
  translationProvider: document.querySelector("#translationProvider"),
  deepgramApiKey: document.querySelector("#deepgramApiKey"),
  cloudTranslationApiKey: document.querySelector("#cloudTranslationApiKey"),
  geminiApiKey: document.querySelector("#geminiApiKey"),
  geminiModel: document.querySelector("#geminiModel"),
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

let cachedState = {
  settings: { ...DEFAULT_SETTINGS },
  sessionState: {
    status: SESSION_STATUS.idle,
    activeTabId: null,
    translationProvider: null,
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
  populateLanguagePairOptions();
  populateOptions(elements.translationProvider, TRANSLATION_PROVIDER_OPTIONS);
  populateOptions(elements.geminiModel, GEMINI_MODEL_OPTIONS);
  populateOptions(elements.displayMode, DISPLAY_MODE_OPTIONS);
  populateOptions(elements.segmentationMode, SEGMENTATION_MODE_OPTIONS);
  bindEvents();
  await refreshState();
}

function bindEvents() {
  elements.overlayOpacity.addEventListener("input", () => {
    elements.overlayOpacityValue.textContent = Number(elements.overlayOpacity.value).toFixed(2);
  });

  elements.translationProvider.addEventListener("change", handleProviderChange);
  elements.languagePair.addEventListener("change", persistDraftSettings);
  elements.displayMode.addEventListener("change", persistDraftSettings);
  elements.segmentationMode.addEventListener("change", persistDraftSettings);
  elements.showSourcePreview.addEventListener("change", persistDraftSettings);
  elements.overlayOpacity.addEventListener("change", persistDraftSettings);
  elements.deepgramApiKey.addEventListener("change", persistDraftSettings);
  elements.cloudTranslationApiKey.addEventListener("change", persistDraftSettings);
  elements.geminiApiKey.addEventListener("change", persistDraftSettings);
  elements.geminiModel.addEventListener("change", persistDraftSettings);
  elements.startButton.addEventListener("click", handleStart);
  elements.stopButton.addEventListener("click", handleStop);

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
  });  
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
  elements.appRoot.dataset.provider = settings.translationProvider || DEFAULT_SETTINGS.translationProvider;
  elements.translationProvider.value = settings.translationProvider || DEFAULT_SETTINGS.translationProvider;
  elements.deepgramApiKey.value = settings.deepgramApiKey || "";
  elements.cloudTranslationApiKey.value = settings.cloudTranslationApiKey || "";
  elements.geminiApiKey.value = settings.geminiApiKey || "";
  elements.geminiModel.value = settings.geminiModel || DEFAULT_SETTINGS.geminiModel;
  elements.languagePair.value = buildLanguagePairValue(settings.sourceLang, settings.targetLang);
  elements.displayMode.value = settings.displayMode;
  elements.segmentationMode.value = settings.segmentationMode;
  elements.showSourcePreview.checked = Boolean(settings.showSourcePreview);
  elements.overlayOpacity.value = String(settings.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity);
  elements.overlayOpacityValue.textContent = Number(elements.overlayOpacity.value).toFixed(2);
}

async function handleProviderChange() {
  elements.appRoot.dataset.provider = elements.translationProvider.value || DEFAULT_SETTINGS.translationProvider;
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

async function persistDraftSettings() {
  const selectedPair = parseLanguagePairValue(elements.languagePair.value);
  const settings = {
    deepgramApiKey: elements.deepgramApiKey.value.trim(),
    translationProvider: elements.translationProvider.value,
    cloudTranslationApiKey: elements.cloudTranslationApiKey.value.trim(),
    geminiApiKey: elements.geminiApiKey.value.trim(),
    geminiModel: elements.geminiModel.value,
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
