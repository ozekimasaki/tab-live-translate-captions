export const STORAGE_KEYS = {
  settings: "settings",
  sessionState: "sessionState",
  runtimeLogsBackground: "runtimeLogsBackground",
  runtimeLogsOffscreen: "runtimeLogsOffscreen"
};

export const RUNTIME_LOG_SOURCES = {
  background: "background",
  offscreen: "offscreen"
};

export const RUNTIME_LOG_MAX_ENTRIES_PER_SOURCE = 120;
export const RUNTIME_LOG_RETURN_LIMIT = 160;
export const RUNTIME_LOG_FLUSH_DELAY_MS = 250;

export const DISPLAY_MODES = {
  translationOnly: "translation-only",
  dual: "dual"
};

export const SEGMENTATION_MODES = {
  latency: "latency",
  balanced: "balanced",
  natural: "natural"
};

export const LATENCY_PREFERENCES = {
  fastest: "fastest",
  balanced: "balanced",
  stable: "stable"
};

export const TRANSLATION_PROVIDERS = {
  cloudTranslation: "cloud-translation",
  gemini: "gemini"
};

export const STT_PROVIDERS = {
  deepgram: "deepgram",
  xai: "xai"
};

export const STT_TRANSPORTS = {
  websocket: "websocket",
  https: "https"
};

export const STT_CONNECTION_STATES = {
  idle: "idle",
  connecting: "connecting",
  ready: "ready",
  streaming: "streaming",
  finalizing: "finalizing",
  closed: "closed"
};

export const STT_PROVIDER_EVENTS = {
  transcriptCreated: "transcript.created",
  transcriptPartial: "transcript.partial",
  transcriptDone: "transcript.done",
  error: "error"
};

export const XAI_STT_MODES = {
  websocketStreaming: "websocket-streaming",
  restTurns: "rest-turns"
};

export const STT_PROVIDER_ALIASES = {
  [STT_PROVIDERS.deepgram]: ["deepgram"],
  [STT_PROVIDERS.xai]: [
    "xai",
    "xai-realtime",
    "xai-websocket",
    "grok",
    "grok-realtime",
    "grok-realtime-ws",
    "grok-stt",
    "grok-stt-rest",
    "grok-stt-realtime",
    "grok-stt-ws"
  ]
};

export const GEMINI_MODELS = {
  flashLite25: "gemini-2.5-flash-lite",
  flashLite31Preview: "gemini-3.1-flash-lite-preview"
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

export const STT_PROVIDER_SOURCE_LANGUAGE_SUPPORT = {
  [STT_PROVIDERS.deepgram]: ["en", "ja", "zh"],
  [STT_PROVIDERS.xai]: ["en", "ja"]
};

export function normalizeSttProvider(value) {
  const normalizedValue = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalizedValue) {
    return DEFAULT_SETTINGS.sttProvider;
  }

  for (const [provider, aliases] of Object.entries(STT_PROVIDER_ALIASES)) {
    if (aliases.includes(normalizedValue)) {
      return provider;
    }
  }

  return DEFAULT_SETTINGS.sttProvider;
}

export const DEFAULT_SETTINGS = {
  sttProvider: STT_PROVIDERS.deepgram,
  deepgramApiKey: "",
  xaiApiKey: "",
  xaiSttMode: XAI_STT_MODES.restTurns,
  translationProvider: TRANSLATION_PROVIDERS.cloudTranslation,
  cloudTranslationApiKey: "",
  geminiApiKey: "",
  geminiModel: GEMINI_MODELS.flashLite25,
  sourceLang: "en",
  targetLang: "ja",
  displayMode: DISPLAY_MODES.translationOnly,
  segmentationMode: SEGMENTATION_MODES.balanced,
  latencyPreference: LATENCY_PREFERENCES.balanced,
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
  contentPing: "CONTENT_PING",
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
