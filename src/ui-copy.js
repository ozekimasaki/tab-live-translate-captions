import {
  DISPLAY_MODES,
  GEMINI_MODELS,
  PRESET_LANGUAGE_PAIRS,
  SEGMENTATION_MODES,
  SESSION_STATUS,
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

export function getPopupStatusModel({ settings, sessionState, support }) {
  const pairLabel = getLanguagePairLabel(settings.sourceLang, settings.targetLang);
  const activeProvider = sessionState.translationProvider || settings.translationProvider;
  const providerLabel = getTranslationProviderLabel(activeProvider);
  const providerChangePending =
    Boolean(sessionState.translationProvider) && sessionState.translationProvider !== settings.translationProvider;
  const pendingProviderLabel = getTranslationProviderLabel(settings.translationProvider);

  if (!support.supported && sessionState.status !== SESSION_STATUS.active) {
    return {
      state: "unsupported",
      badge: "非対応",
      title: "このページでは開始できません",
      hint: support.reason,
      pairLabel: `${providerLabel} · ${pairLabel}`
    };
  }

  switch (sessionState.status) {
    case SESSION_STATUS.starting:
      return {
        state: "starting",
        badge: "接続中",
        title: sessionState.message || "音声処理を開始しています",
        hint: providerChangePending
          ? `${providerLabel} で翻訳中です。${pendingProviderLabel} への切替は次回開始時に反映されます。`
          : `${providerLabel} で翻訳します。最初の字幕が表示されるまで数秒かかることがあります。`,
        pairLabel: `${providerLabel} · ${pairLabel}`
      };
    case SESSION_STATUS.active:
      return {
        state: "active",
        badge: "字幕中",
        title: sessionState.message || "翻訳字幕を表示しています",
        hint: providerChangePending
          ? `${providerLabel} で翻訳中です。${pendingProviderLabel} への切替は次回開始時に反映されます。`
          : `${providerLabel} で翻訳中です。ページ下部の字幕バーはドラッグ移動できます。`,
        pairLabel: `${providerLabel} · ${pairLabel}`
      };
    case SESSION_STATUS.error:
      return {
        state: "error",
        badge: "要確認",
        title: sessionState.message || "処理中にエラーが発生しました",
        hint: providerChangePending
          ? `${providerLabel} のエラーです。${pendingProviderLabel} への切替は次回開始時に反映されます。`
          : `${providerLabel} の API キー、ネットワーク、対象タブの音声出力を確認してください。`,
        pairLabel: `${providerLabel} · ${pairLabel}`
      };
    default:
      return {
        state: "idle",
        badge: "待機中",
        title: "開始すると現在のタブ音声を取得します",
        hint: `通常の Web ページで使えます。既定の翻訳は ${providerLabel} を使います。`,
        pairLabel: `${providerLabel} · ${pairLabel}`
      };
  }
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
