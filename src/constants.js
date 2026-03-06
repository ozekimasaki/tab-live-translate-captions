export const STORAGE_KEYS = {
  settings: "settings",
  sessionState: "sessionState"
};

export const DISPLAY_MODES = {
  translationOnly: "translation-only",
  dual: "dual"
};

export const SEGMENTATION_MODES = {
  latency: "latency",
  balanced: "balanced",
  natural: "natural"
};

export const LANGUAGES = [
  { label: "英語", value: "en" },
  { label: "日本語", value: "ja" },
  { label: "中国語", value: "zh" }
];

export const PRESET_LANGUAGE_PAIRS = [
  { sourceLang: "en", targetLang: "ja", label: "英語 → 日本語" },
  { sourceLang: "zh", targetLang: "ja", label: "中国語 → 日本語" },
  { sourceLang: "ja", targetLang: "en", label: "日本語 → 英語" }
];

export const DEFAULT_SETTINGS = {
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

export const SESSION_STATUS = {
  idle: "idle",
  starting: "starting",
  active: "active",
  stopping: "stopping",
  error: "error"
};

export const MESSAGE_TYPES = {
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
