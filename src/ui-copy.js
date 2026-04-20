import {
  DISPLAY_MODES,
  GEMINI_MODELS,
  LATENCY_PREFERENCES,
  normalizeSttProvider,
  PRESET_LANGUAGE_PAIRS,
  SEGMENTATION_MODES,
  SESSION_STATUS,
  STT_PROVIDERS,
  STT_PROVIDER_SOURCE_LANGUAGE_SUPPORT,
  TRANSLATION_PROVIDERS
} from "./constants.js";

const LANGUAGE_LABELS = {
  en: "英語",
  ja: "日本語",
  zh: "中国語"
};

const PROVIDER_LABELS = {
  [TRANSLATION_PROVIDERS.cloudTranslation]: "Cloud Translation",
  [TRANSLATION_PROVIDERS.gemini]: "Gemini"
};

const STT_PROVIDER_LABELS = {
  [STT_PROVIDERS.deepgram]: "Deepgram",
  [STT_PROVIDERS.xai]: "Grok / xAI"
};

export const DISPLAY_MODE_OPTIONS = [
  {
    value: DISPLAY_MODES.translationOnly,
    label: "翻訳のみ",
    description: "翻訳字幕だけを大きく表示"
  },
  {
    value: DISPLAY_MODES.dual,
    label: "原文 + 翻訳",
    description: "原文を補助表示して確認しやすくする"
  }
];

export const SEGMENTATION_MODE_OPTIONS = [
  {
    value: SEGMENTATION_MODES.latency,
    label: "低遅延",
    description: "字幕を速めに出す"
  },
  {
    value: SEGMENTATION_MODES.balanced,
    label: "標準",
    description: "速さと読みやすさのバランス"
  },
  {
    value: SEGMENTATION_MODES.natural,
    label: "自然",
    description: "まとまりを優先して表示"
  }
];

export const LATENCY_PREFERENCE_OPTIONS = [
  {
    value: LATENCY_PREFERENCES.fastest,
    label: "最速優先",
    description: "差し替えや細かい更新を許容して初速を詰める"
  },
  {
    value: LATENCY_PREFERENCES.balanced,
    label: "バランス",
    description: "初速と読みやすさのバランスを取る"
  },
  {
    value: LATENCY_PREFERENCES.stable,
    label: "安定優先",
    description: "少し遅くても表示の揺れを抑える"
  }
];

export const TRANSLATION_PROVIDER_OPTIONS = [
  {
    value: TRANSLATION_PROVIDERS.cloudTranslation,
    label: "Cloud Translation",
    description: "安定して速く翻訳する"
  },
  {
    value: TRANSLATION_PROVIDERS.gemini,
    label: "Gemini",
    description: "生成モデルで翻訳する"
  }
];

export const STT_PROVIDER_OPTIONS = [
  {
    value: STT_PROVIDERS.deepgram,
    label: "Deepgram",
    description: "既存のリアルタイム音声認識"
  },
  {
    value: STT_PROVIDERS.xai,
    label: "Grok / xAI",
    description: "短い区間ごとに xAI へ送って低遅延に認識する"
  }
];

export const GEMINI_MODEL_OPTIONS = [
  {
    value: GEMINI_MODELS.flashLite25,
    label: "Gemini 2.5 Flash Lite",
    description: "安定寄りの lite モデル"
  },
  {
    value: GEMINI_MODELS.flashLite31Preview,
    label: "Gemini 3.1 Flash Lite Preview",
    description: "preview モデルを試す"
  }
];

export function getLanguageLabel(language) {
  return LANGUAGE_LABELS[language] || String(language || "").toUpperCase();
}

export function buildLanguagePairValue(sourceLang, targetLang) {
  return `${sourceLang}:${targetLang}`;
}

export function parseLanguagePairValue(value) {
  const [sourceLang, targetLang] = String(value || "").split(":");
  return (
    PRESET_LANGUAGE_PAIRS.find((pair) => pair.sourceLang === sourceLang && pair.targetLang === targetLang) ||
    PRESET_LANGUAGE_PAIRS[0]
  );
}

export function getLanguagePairLabel(sourceLang, targetLang) {
  return `${getLanguageLabel(sourceLang)} → ${getLanguageLabel(targetLang)}`;
}

export function getTranslationProviderLabel(provider) {
  return PROVIDER_LABELS[provider] || "Translation";
}

export function getSttProviderLabel(provider) {
  return STT_PROVIDER_LABELS[normalizeSttProvider(provider)] || "STT";
}

export function getSupportedLanguagePairsForSttProvider(sttProvider) {
  const normalizedProvider = normalizeSttProvider(sttProvider);
  const supportedSourceLanguages =
    STT_PROVIDER_SOURCE_LANGUAGE_SUPPORT[normalizedProvider] ||
    STT_PROVIDER_SOURCE_LANGUAGE_SUPPORT[STT_PROVIDERS.deepgram] ||
    [];
  return PRESET_LANGUAGE_PAIRS.filter((pair) => supportedSourceLanguages.includes(pair.sourceLang));
}

export function getSttCompatibilityHint(sttProvider, sourceLang) {
  const normalizedProvider = normalizeSttProvider(sttProvider);
  if (normalizedProvider === STT_PROVIDERS.xai && sourceLang === "zh") {
    return "Grok / xAI STT は現在、中国語入力に対応していません。英語または日本語の翻訳方向を選んでください。";
  }

  if (normalizedProvider === STT_PROVIDERS.xai) {
    return "Grok / xAI STT は現在、英語と日本語の入力に対応しています。短い発話区間ごとに xAI へ送って文字起こしします。";
  }

  return "";
}

export function getPopupStatusModel({ settings, sessionState, support }) {
  const sessionRunning = [SESSION_STATUS.starting, SESSION_STATUS.active, SESSION_STATUS.error].includes(sessionState.status);
  const activeTranslationProvider = sessionState.translationProvider || settings.translationProvider;
  const activeSttProvider = normalizeSttProvider(sessionState.sttProvider || settings.sttProvider);
  const activeSourceLang = sessionRunning ? sessionState.sourceLang || settings.sourceLang : settings.sourceLang;
  const activeTargetLang = sessionRunning ? sessionState.targetLang || settings.targetLang : settings.targetLang;
  const pairLabel = getLanguagePairLabel(activeSourceLang, activeTargetLang);
  const translationProviderLabel = getTranslationProviderLabel(activeTranslationProvider);
  const sttProviderLabel = getSttProviderLabel(activeSttProvider);
  const translationProviderChangePending =
    sessionRunning && Boolean(sessionState.translationProvider) && sessionState.translationProvider !== settings.translationProvider;
  const pendingSttProvider = normalizeSttProvider(settings.sttProvider);
  const sttProviderChangePending = Boolean(sessionState.sttProvider) && activeSttProvider !== pendingSttProvider;
  const geminiModelChangePending =
    sessionRunning &&
    activeTranslationProvider === TRANSLATION_PROVIDERS.gemini &&
    Boolean(sessionState.geminiModel) &&
    sessionState.geminiModel !== settings.geminiModel;
  const languagePairChangePending =
    sessionRunning &&
    Boolean(sessionState.sourceLang) &&
    (sessionState.sourceLang !== settings.sourceLang || sessionState.targetLang !== settings.targetLang);
  const pendingTranslationProviderLabel = getTranslationProviderLabel(settings.translationProvider);
  const pendingSttProviderLabel = getSttProviderLabel(pendingSttProvider);
  const runtimeLabel = `${sttProviderLabel} · ${translationProviderLabel}`;
  const sttRuntimeHint = getSttRuntimeHint(activeSttProvider);
  const changeNotes = [];

  if (translationProviderChangePending) {
    changeNotes.push(`翻訳は ${pendingTranslationProviderLabel} を次回開始時に反映`);
  }

  if (geminiModelChangePending) {
    changeNotes.push("Gemini モデルは次回開始時に反映");
  }

  if (sttProviderChangePending) {
    changeNotes.push(`STT は ${pendingSttProviderLabel} を次回開始時に反映`);
  }

  if (languagePairChangePending) {
    changeNotes.push("翻訳方向は次回開始時に反映");
  }

  const settingsHint = changeNotes.length > 0 ? ` ${changeNotes.join(" / ")}。` : "";

  if (!support.supported && sessionState.status !== SESSION_STATUS.active) {
    return {
      state: "unsupported",
      badge: "非対応",
      title: "このページでは開始できません",
      hint: support.reason,
      pairLabel: `${runtimeLabel} · ${pairLabel}`
    };
  }

  switch (sessionState.status) {
    case SESSION_STATUS.starting:
      return {
        state: "starting",
        badge: "接続中",
        title: sessionState.message || "音声処理を開始しています",
        hint:
          `${sttRuntimeHint} で音声認識し、${translationProviderLabel} で翻訳します。` +
          `最初の字幕が表示されるまで数秒かかることがあります。${settingsHint}`.trim(),
        pairLabel: `${runtimeLabel} · ${pairLabel}`
      };
    case SESSION_STATUS.active:
      return {
        state: "active",
        badge: "字幕中",
        title: sessionState.message || "翻訳字幕を表示しています",
        hint:
          `${sttRuntimeHint} で音声認識し、${translationProviderLabel} で翻訳中です。` +
          `ページ下部の字幕バーはドラッグ移動できます。${settingsHint}`.trim(),
        pairLabel: `${runtimeLabel} · ${pairLabel}`
      };
    case SESSION_STATUS.error:
      return {
        state: "error",
        badge: "要確認",
        title: sessionState.message || "処理中にエラーが発生しました",
        hint:
          `${runtimeLabel} の API キー、ネットワーク、対象タブの音声出力を確認してください。${settingsHint}`.trim(),
        pairLabel: `${runtimeLabel} · ${pairLabel}`
      };
    default:
      return {
        state: "idle",
        badge: "待機中",
        title: "開始すると現在のタブ音声を取得します",
        hint: `通常の Web ページで使えます。既定では ${sttRuntimeHint} で音声認識し、${translationProviderLabel} で翻訳します。`,
        pairLabel: `${runtimeLabel} · ${pairLabel}`
      };
  }
}

function getSttRuntimeHint(provider) {
  return normalizeSttProvider(provider) === STT_PROVIDERS.xai ? "xAI low-latency HTTPS" : "Deepgram realtime";
}

export function getActiveTabSummary(activeTab, support) {
  if (!activeTab?.id) {
    return {
      title: "対象タブを取得できません",
      meta: "字幕を出したいページを前面にしてから開いてください。"
    };
  }

  const hostname = getHostname(activeTab.url);
  const title = compactText(activeTab.title || hostname || "現在のタブ", 48);

  if (!support.supported) {
    return {
      title,
      meta: support.reason
    };
  }

  return {
    title,
    meta: hostname || "通常の Web ページ"
  };
}

export function getOverlayStatusLabel(sessionStatus, statusText) {
  if (statusText && sessionStatus !== SESSION_STATUS.idle) {
    return statusText;
  }

  switch (sessionStatus) {
    case SESSION_STATUS.starting:
      return "接続中";
    case SESSION_STATUS.active:
      return "字幕表示中";
    case SESSION_STATUS.error:
      return "要確認";
    default:
      return "待機中";
  }
}

export function getOverlayPlaceholder(sessionStatus) {
  if (sessionStatus === SESSION_STATUS.active || sessionStatus === SESSION_STATUS.starting) {
    return "翻訳字幕を生成しています…";
  }

  return "音声を待機しています…";
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

  return `${value.slice(0, maxLength - 1)}…`;
}
