import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import {
  DEFAULT_SETTINGS,
  LATENCY_PREFERENCES,
  MESSAGE_TYPES,
  RUNTIME_LOG_SOURCES,
  SESSION_STATUS,
  STT_CONNECTION_STATES,
  STT_PROVIDER_EVENTS,
  STT_PROVIDERS,
  STT_TRANSPORTS,
  TRANSLATION_PROVIDERS
} from "./constants.js";
import { createRuntimeLogger } from "./runtime-log.js";

const DEEPGRAM_MODEL = "nova-3";
const CLOUD_TRANSLATION_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const XAI_STT_ENDPOINT = "https://api.x.ai/v1/stt";
const TARGET_SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SAMPLE = 2;
const KEEP_ALIVE_MS = 8000;
const AUTO_STOP_MS = 5 * 60 * 1000;
const GEMINI_MAX_OUTPUT_TOKENS = 64;
const MAX_CONCURRENT_TRANSLATIONS = 2;
const TRANSLATION_UNAVAILABLE_TEXT = "翻訳を取得できませんでした。";
const DEBUG_LOG_PREFIX = "[deepfram/offscreen]";
const runtimeLogger = createRuntimeLogger(RUNTIME_LOG_SOURCES.offscreen, DEBUG_LOG_PREFIX);
const STREAMING_UPDATE_DEBOUNCE_MS = 140;
const STREAMING_MIN_EMIT_CHARS = 6;
const TOKEN_TIME_TOLERANCE_MS = 80;
const BUFFER_COMPACT_THRESHOLD = 48;
const HARD_BOUNDARY_PUNCTUATION_RE = /[.!?。！？]$/u;
const SOFT_BOUNDARY_PUNCTUATION_RE = /[,;:、，；：]$/u;
const TRANSLATION_MAX_ATTEMPTS = 2;
const CLOUD_TRANSLATION_TIMEOUT_MS = 4000;
const CLOUD_TRANSLATION_RETRY_DELAY_MS = 250;
const GEMINI_REQUEST_TIMEOUT_MS = 6000;
const GEMINI_STREAM_INACTIVITY_TIMEOUT_MS = 4000;
const GEMINI_RETRY_DELAY_MS = 350;
const BACKGROUND_DELIVERY_MAX_ATTEMPTS = 8;
const BACKGROUND_DELIVERY_RETRY_BASE_MS = 120;
const XAI_STT_MAX_ATTEMPTS = 2;
const XAI_STT_TIMEOUT_MS = 12000;
const XAI_STT_RETRY_DELAY_MS = 500;
const XAI_MIN_SPEECH_MS = 220;
const XAI_VAD_LEVEL_FLOOR = 0.0035;
const XAI_PCM_MIME_TYPE = "audio/L16";
const XAI_RAW_AUDIO_FORMAT = "pcm";
const XAI_PROVIDER_ALIASES = new Set(["xai", "grok", "grok-stt", "grok-stt-rest"]);
const XAI_FORMATTING_LANGUAGES = new Set(["en", "ja"]);
const SPACELESS_LANGUAGES = new Set(["ja", "zh"]);
const ENGLISH_SOFT_BOUNDARY_CONTINUERS = new Set([
  "and",
  "but",
  "or",
  "so",
  "because",
  "if",
  "when",
  "that",
  "to",
  "of",
  "a",
  "an",
  "the"
]);
const htmlEntityDecoder = document.createElement("textarea");
const SEGMENTATION_PROFILES = {
  latency: {
    endpointingMs: 180,
    wordGapMs: 280,
    softLookaheadMs: 140,
    minWords: 3,
    maxWords: 10,
    maxDurationMs: 2200
  },
  balanced: {
    endpointingMs: 260,
    wordGapMs: 420,
    softLookaheadMs: 260,
    minWords: 4,
    maxWords: 16,
    maxDurationMs: 3200
  },
  natural: {
    endpointingMs: 380,
    wordGapMs: 650,
    softLookaheadMs: 420,
    minWords: 5,
    maxWords: 22,
    maxDurationMs: 4600
  }
};
const LATENCY_BEHAVIOR_PROFILES = {
  [LATENCY_PREFERENCES.fastest]: {
    deepgramSpeculativeMinChars: 8,
    deepgramSpeculativeDebounceMs: 180,
    xaiSilenceOffsetMs: -70,
    xaiMaxTurnOffsetMs: -220,
    xaiPreRollOffsetMs: -30
  },
  [LATENCY_PREFERENCES.balanced]: {
    deepgramSpeculativeMinChars: 12,
    deepgramSpeculativeDebounceMs: 260,
    xaiSilenceOffsetMs: 0,
    xaiMaxTurnOffsetMs: 0,
    xaiPreRollOffsetMs: 0
  },
  [LATENCY_PREFERENCES.stable]: {
    deepgramSpeculativeMinChars: 18,
    deepgramSpeculativeDebounceMs: 420,
    xaiSilenceOffsetMs: 120,
    xaiMaxTurnOffsetMs: 360,
    xaiPreRollOffsetMs: 40
  }
};
const GUARDED_BACKGROUND_MESSAGE_TYPES = new Set([
  MESSAGE_TYPES.sessionError,
  MESSAGE_TYPES.sessionStatusChanged
]);

let nextSessionId = 1;
let session = createEmptySession();
const backgroundDeliveryQueue = [];
let isPumpingBackgroundDeliveryQueue = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.recipient !== "offscreen") {
    return undefined;
  }

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || "不明なエラーが発生しました。"
      });
    });

  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case MESSAGE_TYPES.startSession:
      await startSession(message.payload);
      return {};
    case MESSAGE_TYPES.settingsUpdated:
      if (session.settings?.latencyPreference !== message.settings?.latencyPreference) {
        clearSpeculativeTranslationState();
      }
      session.settings = {
        ...session.settings,
        ...message.settings
      };
      await reschedulePendingTimers();
      return {};
    case MESSAGE_TYPES.stopSession:
      await stopSession();
      return {};
    default:
      return {};
  }
}

async function startSession({ tabId, streamId, settings, runtimeSessionId }) {
  await stopSession();

  session = createEmptySession();
  session.tabId = tabId;
  session.settings = settings;
  session.runtimeSessionId = runtimeSessionId || null;
  session.sttProvider = getSttProvider(settings);
  session.sttTransport = getSttTransport(settings);
  session.sttConnectionState = STT_CONNECTION_STATES.connecting;
  if (session.sttProvider === STT_PROVIDERS.deepgram) {
    session.deepgram = createClient(settings.deepgramApiKey);
  }
  debugLog("session:start", {
    sessionId: session.sessionId,
    tabId,
    sttProvider: session.sttProvider,
    translationProvider: settings.translationProvider,
    geminiModel: settings.translationProvider === TRANSLATION_PROVIDERS.gemini ? getGeminiModel(settings) : null,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    segmentationMode: settings.segmentationMode,
    latencyPreference: settings.latencyPreference
  });

  await notifyBackground({
    type: MESSAGE_TYPES.sessionStatusChanged,
    status: SESSION_STATUS.starting,
    message: getSessionStartingMessage(session.sttProvider, session.sttTransport),
    sttTransport: session.sttTransport,
    sttConnectionState: session.sttConnectionState,
    utteranceIndex: session.utteranceIndex
  });

  try {
    const capturedStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      }
    });

    const audioTracks = capturedStream.getAudioTracks();
    if (!audioTracks.length) {
      throw new Error("タブ音声トラックを取得できませんでした。");
    }

    session.mediaStream = new MediaStream(audioTracks);

    for (const videoTrack of capturedStream.getVideoTracks()) {
      videoTrack.stop();
    }

    session.mediaStream.getAudioTracks()[0].addEventListener("ended", async () => {
      if (!session.isStopping) {
        await handleFatalError(new Error("タブ音声の取得が終了しました。"));
      }
    });

    session.audioContext = new AudioContext({
      latencyHint: "interactive"
    });

    if (session.audioContext.state === "suspended") {
      await session.audioContext.resume();
    }
    await session.audioContext.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet.js"));

    const sourceNode = session.audioContext.createMediaStreamSource(session.mediaStream);
    const monitorGain = session.audioContext.createGain();
    const silentGain = session.audioContext.createGain();
    const recorderNode = new AudioWorkletNode(session.audioContext, "deepfram-pcm-recorder", {
      processorOptions: {
        targetSampleRate: TARGET_SAMPLE_RATE
      }
    });

    monitorGain.gain.value = 1;
    silentGain.gain.value = 0;

    sourceNode.connect(monitorGain);
    monitorGain.connect(session.audioContext.destination);
    sourceNode.connect(recorderNode);
    recorderNode.connect(silentGain);
    silentGain.connect(session.audioContext.destination);

    session.sourceNode = sourceNode;
    session.monitorGain = monitorGain;
    session.silentGain = silentGain;
    session.recorderNode = recorderNode;

    recorderNode.port.onmessage = (event) => {
      if (!event.data?.audioBuffer || session.isStopping) {
        return;
      }

      session.currentAudioLevel = Number(event.data.level || 0);
      session.currentSilentForMs = Number(event.data.silentForMs || 0);

      if (!session.hasReceivedAudio) {
        session.hasReceivedAudio = true;
        session.sttConnectionState = STT_CONNECTION_STATES.streaming;
        debugLog("audio:detected", {
          sessionId: session.sessionId,
          sampleRate: TARGET_SAMPLE_RATE
        });
        notifyBackground({
          type: MESSAGE_TYPES.sessionStatusChanged,
          status: SESSION_STATUS.active,
          message: getSpeechDetectedMessage(session.sttProvider, session.sttTransport),
          sttTransport: session.sttTransport,
          sttConnectionState: session.sttConnectionState,
          utteranceIndex: session.utteranceIndex
        });
      }

      if (session.sttProvider === STT_PROVIDERS.xai) {
        void handleXaiAudioChunk(event.data);
        return;
      }

      if (!session.connection) {
        return;
      }

      session.connection.send(event.data.audioBuffer);
    };

    if (session.sttProvider === STT_PROVIDERS.deepgram) {
      const segmentationProfile = getSegmentationProfile(settings.segmentationMode);
      debugLog("deepgram:connect", {
        sessionId: session.sessionId,
        endpointingMs: segmentationProfile.endpointingMs,
        wordGapMs: segmentationProfile.wordGapMs,
        maxWords: segmentationProfile.maxWords
      });
      session.connection = session.deepgram.listen.live({
        model: DEEPGRAM_MODEL,
        language: mapDeepgramLanguage(settings.sourceLang),
        punctuate: true,
        smart_format: true,
        utterances: true,
        interim_results: true,
        endpointing: segmentationProfile.endpointingMs,
        utterance_end_ms: 1000,
        vad_events: true,
        encoding: "linear16",
        sample_rate: TARGET_SAMPLE_RATE,
        channels: 1
      });

      bindDeepgramEvents(session.connection);
    } else {
      const xaiTurnProfile = getXaiTurnProfile(settings.segmentationMode, settings.latencyPreference);
      session.sttConnectionState = STT_CONNECTION_STATES.ready;
      debugLog("xai:ready", {
        sessionId: session.sessionId,
        silenceFlushMs: xaiTurnProfile.silenceFlushMs,
        maxTurnMs: xaiTurnProfile.maxTurnMs,
        preRollMs: xaiTurnProfile.preRollMs
      });
      await notifyBackground({
        type: MESSAGE_TYPES.sessionStatusChanged,
        status: SESSION_STATUS.active,
        message: "タブ音声を待機しています…",
        sttTransport: session.sttTransport,
        sttConnectionState: session.sttConnectionState,
        utteranceIndex: session.utteranceIndex
      });
    }

    resetAutoStopTimer();
  } catch (error) {
    await handleFatalError(error);
    throw error;
  }
}

function bindDeepgramEvents(connection) {
  connection.on(LiveTranscriptionEvents.Open, async () => {
    session.sttConnectionState = STT_CONNECTION_STATES.streaming;
    debugLog("deepgram:open", {
      sessionId: session.sessionId
    });
    session.keepAliveTimer = setInterval(() => {
      connection.keepAlive();
    }, KEEP_ALIVE_MS);

    await notifyBackground({
      type: MESSAGE_TYPES.sessionStatusChanged,
      status: SESSION_STATUS.active,
      message: "字幕生成中",
      sttTransport: session.sttTransport,
      sttConnectionState: session.sttConnectionState,
      utteranceIndex: session.utteranceIndex
    });
  });

  connection.on(LiveTranscriptionEvents.Transcript, async (payload) => {
    resetAutoStopTimer();
    const transcript = payload?.channel?.alternatives?.[0]?.transcript?.trim() || "";

    if (!payload.is_final) {
      if (!transcript) {
        return;
      }

      session.latestInterimTail = trimKnownPrefix(transcript, getPendingFinalizedText());
      maybeLogInterimProgress();
      await publishPreviewTranscript();
      return;
    }

    const finalTokens = extractFinalTokensFromPayload(payload, transcript);
    session.latestInterimTail = "";
    debugLog("deepgram:final", {
      sessionId: session.sessionId,
      transcriptChars: transcript.length,
      tokenCount: finalTokens.length,
      speechFinal: Boolean(payload.speech_final)
    });

    appendFinalWordTokens(finalTokens);

    if (payload.speech_final) {
      await evaluatePendingBoundaries("speech-final", {
        forceReason: "speech-final"
      });
      return;
    }

    await evaluatePendingBoundaries("final");
  });

  connection.on(LiveTranscriptionEvents.UtteranceEnd, async (payload) => {
    debugLog("deepgram:utterance-end", {
      sessionId: session.sessionId,
      lastWordEndMs: toMilliseconds(payload?.last_word_end)
    });
    session.latestInterimTail = "";
    await evaluatePendingBoundaries("utterance-end", {
      forceReason: "utterance-end",
      utteranceEndMs: toMilliseconds(payload?.last_word_end)
    });
  });

  connection.on(LiveTranscriptionEvents.Error, async (error) => {
    debugLog("deepgram:error", {
      sessionId: session.sessionId,
      message: error?.message || String(error)
    });
    await handleFatalError(error);
  });

  connection.on(LiveTranscriptionEvents.Close, async () => {
    if (session.isStopping) {
      return;
    }

    debugLog("deepgram:close", {
      sessionId: session.sessionId
    });
    await handleFatalError(new Error("Deepgram 接続が終了しました。"));
  });
}

async function handleXaiAudioChunk(data) {
  const audioBuffer = cloneAudioBuffer(data?.audioBuffer);
  if (!audioBuffer.byteLength) {
    return;
  }

  const level = Number(data?.level || 0);
  const rawIsSilent = Boolean(data?.isSilent);
  const isSpeechLike = !rawIsSilent || level >= XAI_VAD_LEVEL_FLOOR;
  const chunk = {
    audioBuffer,
    durationMs: getPcmDurationMs(audioBuffer),
    isSilent: !isSpeechLike,
    level
  };
  const profile = getXaiTurnProfile(session.settings?.segmentationMode, session.settings?.latencyPreference);

  if (!session.xaiCurrentTurn) {
    if (chunk.isSilent) {
      rememberXaiPreRollChunk(chunk, profile.preRollMs);
      return;
    }

    if (rawIsSilent) {
      debugLog("xai:vad-override", {
        sessionId: session.sessionId,
        level
      });
    }
    startXaiTurn();
  }

  appendChunkToXaiTurn(chunk);

  if (!chunk.isSilent) {
    resetAutoStopTimer();
  }

  const flushReason = getXaiTurnFlushReason(profile);
  if (flushReason) {
    await flushCurrentXaiTurn(flushReason);
  }
}

function startXaiTurn() {
  const preRollChunks = session.xaiPreRollChunks;
  let durationMs = 0;
  let trailingSilenceMs = 0;

  if (preRollChunks.length) {
    durationMs = preRollChunks.reduce((total, chunk) => total + chunk.durationMs, 0);
    trailingSilenceMs = durationMs;
  }

  session.xaiCurrentTurn = {
    chunks: [...preRollChunks],
    durationMs,
    speechMs: 0,
    trailingSilenceMs
  };
  session.xaiPreRollChunks = [];
  debugLog("xai:turn-start", {
    sessionId: session.sessionId,
    preRollMs: durationMs
  });
}

function appendChunkToXaiTurn(chunk) {
  if (!session.xaiCurrentTurn) {
    return;
  }

  session.xaiCurrentTurn.chunks.push(chunk);
  session.xaiCurrentTurn.durationMs += chunk.durationMs;

  if (chunk.isSilent) {
    session.xaiCurrentTurn.trailingSilenceMs += chunk.durationMs;
    return;
  }

  session.xaiCurrentTurn.speechMs += chunk.durationMs;
  session.xaiCurrentTurn.trailingSilenceMs = 0;
}

function rememberXaiPreRollChunk(chunk, preRollMs) {
  session.xaiPreRollChunks.push(chunk);

  let totalDurationMs = session.xaiPreRollChunks.reduce((total, item) => total + item.durationMs, 0);
  while (session.xaiPreRollChunks.length > 1 && totalDurationMs > preRollMs) {
    totalDurationMs -= session.xaiPreRollChunks.shift()?.durationMs || 0;
  }
}

function getXaiTurnFlushReason(profile) {
  const turn = session.xaiCurrentTurn;
  if (!turn) {
    return null;
  }

  if (turn.trailingSilenceMs >= profile.silenceFlushMs) {
    return "silence";
  }

  if (turn.durationMs >= profile.maxTurnMs) {
    return "duration";
  }

  return null;
}

async function flushCurrentXaiTurn(reason) {
  const turn = session.xaiCurrentTurn;
  session.xaiCurrentTurn = null;

  if (!turn || turn.speechMs < XAI_MIN_SPEECH_MS || !turn.chunks.length) {
    if (turn?.chunks.length) {
      debugLog("xai:skip-turn", {
        sessionId: session.sessionId,
        reason: "too-short",
        flushReason: reason,
        durationMs: turn.durationMs,
        speechMs: turn.speechMs
      });
    }
    return;
  }

  const audioBuffer = mergePcmChunks(turn.chunks);
  if (!audioBuffer.byteLength) {
    return;
  }

  session.utteranceIndex += 1;
  session.xaiTurnQueue.push({
    audioBuffer,
    durationMs: turn.durationMs,
    speechMs: turn.speechMs,
    reason
  });
  debugLog("xai:turn-flush", {
    sessionId: session.sessionId,
    reason,
    durationMs: turn.durationMs,
    speechMs: turn.speechMs,
    queueLength: session.xaiTurnQueue.length
  });
  await notifyBackground({
    type: MESSAGE_TYPES.sessionStatusChanged,
    status: SESSION_STATUS.active,
    message: "xAI に音声区間を送信しています…",
    sttTransport: session.sttTransport,
    sttConnectionState: session.sttConnectionState,
    utteranceIndex: session.utteranceIndex
  });
  void pumpXaiTurnQueue(session.sessionId);
}

async function pumpXaiTurnQueue(sessionId) {
  if (session.isPumpingXaiTurnQueue) {
    return;
  }

  session.isPumpingXaiTurnQueue = true;

  try {
    while (session.sessionId === sessionId && !session.isStopping && session.xaiTurnQueue.length > 0) {
      const turn = session.xaiTurnQueue.shift();
      if (!turn) {
        continue;
      }

      await transcribeXaiTurn(turn, sessionId);
    }
  } finally {
    if (session.sessionId === sessionId) {
      session.isPumpingXaiTurnQueue = false;
    }
  }
}

async function transcribeXaiTurn(turn, sessionId) {
  const abortController = new AbortController();
  session.transcriptionAbortControllers.add(abortController);
  let lastError = null;

  try {
    for (let attempt = 1; attempt <= XAI_STT_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        debugLog("xai:retry", {
          sessionId,
          attempt,
          reason: getTranscriptionErrorCode(lastError),
          message: lastError?.message || null
        });
        await sleep(XAI_STT_RETRY_DELAY_MS);
      }

      if (session.sessionId !== sessionId || session.isStopping || abortController.signal.aborted) {
        return;
      }

      try {
        debugLog("xai:request-start", {
          sessionId,
          attempt,
          utteranceIndex: session.utteranceIndex,
          durationMs: turn.durationMs,
          speechMs: turn.speechMs
        });
        await notifyBackground({
          type: MESSAGE_TYPES.sessionStatusChanged,
          status: SESSION_STATUS.active,
          message: "xAI で文字起こし中です…",
          sttTransport: session.sttTransport,
          sttConnectionState: session.sttConnectionState,
          utteranceIndex: session.utteranceIndex
        });
        const payload = await requestXaiTranscription({
          apiKey: getXaiApiKey(session.settings),
          sourceLang: session.settings?.sourceLang,
          audioBuffer: turn.audioBuffer,
          signal: abortController.signal
        });
        const transcript = extractXaiTranscript(payload, session.settings?.sourceLang);
        if (!transcript) {
          throw createTranscriptionError("empty", "xAI から文字起こしを取得できませんでした。");
        }

        const recoveredAfterFailures = session.xaiConsecutiveTurnFailures > 0;
        session.xaiConsecutiveTurnFailures = 0;
        debugLog("xai:completed", {
          sessionId,
          attempt,
          durationMs: turn.durationMs,
          speechMs: turn.speechMs,
          chars: transcript.length
        });
        await emitFinalTranscriptSegment(transcript);
        if (recoveredAfterFailures && !session.isStopping && session.sessionId === sessionId) {
          await notifyBackground({
            type: MESSAGE_TYPES.sessionStatusChanged,
            status: SESSION_STATUS.active,
            message: getSpeechDetectedMessage(session.sttProvider, session.sttTransport),
            sttTransport: session.sttTransport,
            sttConnectionState: session.sttConnectionState,
            utteranceIndex: session.utteranceIndex
          });
        }
        return;
      } catch (error) {
        if (abortController.signal.aborted && (session.isStopping || error?.name === "AbortError")) {
          throw error;
        }

        lastError = normalizeTranscriptionError(error);
        debugLog("xai:error", {
          sessionId,
          attempt,
          reason: getTranscriptionErrorCode(lastError),
          status: Number.isFinite(lastError?.status) ? lastError.status : null,
          message: lastError?.message || String(lastError)
        });

        if (attempt >= XAI_STT_MAX_ATTEMPTS || !shouldRetryTranscriptionError(lastError)) {
          throw lastError;
        }
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError" && session.sessionId === sessionId && !session.isStopping) {
      const normalizedError = normalizeTranscriptionError(error);
      if (shouldSkipTranscriptionError(normalizedError)) {
        await handleSkippedXaiTurn(normalizedError, sessionId);
        return;
      }

      await handleFatalError(normalizedError);
    }
  } finally {
    session.transcriptionAbortControllers.delete(abortController);
  }
}

async function requestXaiTranscription({ apiKey, sourceLang, audioBuffer, signal }) {
  const attemptSignal = createAttemptSignalManager(signal, {
    timeoutMs: XAI_STT_TIMEOUT_MS,
    timeoutMessage: "xAI の文字起こしがタイムアウトしました。"
  });

  try {
    if (!apiKey) {
      throw createTranscriptionError("auth", "xAI API Key を入力してください。");
    }

    const formData = new FormData();
    const language = mapXaiLanguage(sourceLang);
    formData.append("audio_format", XAI_RAW_AUDIO_FORMAT);
    formData.append("sample_rate", String(TARGET_SAMPLE_RATE));

    if (language && XAI_FORMATTING_LANGUAGES.has(language)) {
      formData.append("language", language);
      formData.append("format", "true");
    }

    formData.append("file", new Blob([audioBuffer], { type: XAI_PCM_MIME_TYPE }), "turn.pcm");

    const response = await fetch(XAI_STT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData,
      signal: attemptSignal.signal
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw createHttpError(`xAI STT API ${response.status}: ${bodyText}`, response.status);
    }

    return response.json();
  } catch (error) {
    throw attemptSignal.wrapError(error);
  } finally {
    attemptSignal.cleanup();
  }
}

function extractXaiTranscript(payload, sourceLang) {
  const directText = normalizeModelText(payload?.text);
  if (directText) {
    return directText;
  }

  const words = Array.isArray(payload?.words) ? payload.words.map(createXaiWordToken).filter(Boolean) : [];
  return buildTranscriptFromTokens(words, sourceLang);
}

function createXaiWordToken(word) {
  const displayText = normalizeTokenText(word?.text);
  if (!displayText) {
    return null;
  }

  return {
    baseText: displayText,
    displayText,
    startMs: toMilliseconds(word?.start),
    endMs: toMilliseconds(word?.end)
  };
}

function maybeLogXaiInterimProgress() {
  return undefined;
}

async function streamTranslateWithGemini({ apiKey, model, sourceLang, targetLang, text, signal, onPartialUpdate }) {
  const attemptSignal = createAttemptSignalManager(signal, {
    timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
    timeoutMessage: "Gemini の応答がタイムアウトしました。",
    stallTimeoutMs: GEMINI_STREAM_INACTIVITY_TIMEOUT_MS,
    stallMessage: "Gemini のストリーム応答が停止しました。"
  });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(buildGeminiRequestBody(model, sourceLang, targetLang, text)),
        signal: attemptSignal.signal
      }
    );

    if (!response.ok) {
      const bodyText = await response.text();
      if (response.status === 400 || response.status === 404) {
        return translateWithGemini({
          apiKey,
          model,
          sourceLang,
          targetLang,
          text,
          disableThinking: true,
          signal: attemptSignal.signal
        });
      }

      throw createHttpError(`Gemini API ${response.status}: ${bodyText}`, response.status);
    }

    if (!response.body) {
      throw createTranslationError("empty", "Gemini のストリーム応答を取得できませんでした。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assembledText = "";

    attemptSignal.touchStallTimeout();

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        attemptSignal.clearStallTimeout();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      attemptSignal.touchStallTimeout();

      let eventBlock;
      while ((eventBlock = takeNextSseEvent(buffer))) {
        buffer = eventBlock.rest;
        const chunkText = parseGeminiSseChunk(eventBlock.block);
        if (!chunkText) {
          continue;
        }

        assembledText += chunkText;
        await onPartialUpdate(assembledText.trimStart());
      }
    }

    const trailingChunk = parseGeminiSseChunk(buffer);
    if (trailingChunk) {
      assembledText += trailingChunk;
    }

    assembledText = assembledText.trim();
    if (!assembledText) {
      return translateWithGemini({
        apiKey,
        model,
        sourceLang,
        targetLang,
        text,
        disableThinking: true,
        signal: attemptSignal.signal
      });
    }

    return assembledText;
  } catch (error) {
    throw attemptSignal.wrapError(error);
  } finally {
    attemptSignal.cleanup();
  }
}

async function translateWithProviderAttempt({ provider, apiKey, model, sourceLang, targetLang, text, signal, onPartialUpdate }) {
  if (provider === TRANSLATION_PROVIDERS.cloudTranslation) {
    return translateWithCloudTranslation({
      apiKey,
      sourceLang,
      targetLang,
      text,
      signal
    });
  }

  return streamTranslateWithGemini({
    apiKey,
    model,
    sourceLang,
    targetLang,
    text,
    signal,
    onPartialUpdate
  });
}

async function translateWithCloudTranslation({ apiKey, sourceLang, targetLang, text, signal }) {
  const attemptSignal = createAttemptSignalManager(signal, {
    timeoutMs: CLOUD_TRANSLATION_TIMEOUT_MS,
    timeoutMessage: "Cloud Translation の応答がタイムアウトしました。"
  });

  try {
    const response = await fetch(`${CLOUD_TRANSLATION_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: text,
        source: mapTranslationLanguage(TRANSLATION_PROVIDERS.cloudTranslation, sourceLang),
        target: mapTranslationLanguage(TRANSLATION_PROVIDERS.cloudTranslation, targetLang),
        format: "text"
      }),
      signal: attemptSignal.signal
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw createHttpError(`Cloud Translation API ${response.status}: ${bodyText}`, response.status);
    }

    const data = await response.json();
    const translatedText = decodeHtmlEntities(data?.data?.translations?.[0]?.translatedText || "");
    const normalizedText = normalizeModelText(translatedText);

    if (!normalizedText) {
      throw createTranslationError("empty", "Cloud Translation から翻訳結果を取得できませんでした。");
    }

    return normalizedText;
  } catch (error) {
    throw attemptSignal.wrapError(error);
  } finally {
    attemptSignal.cleanup();
  }
}

function buildGeminiRequestBody(model, sourceLang, targetLang, text, { disableThinking = false } = {}) {
  const body = {
    contents: [
      {
        parts: [
          {
            text: buildTranslationPrompt(sourceLang, targetLang, text)
          }
        ]
      }
    ]
  };

  body.generationConfig = {
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
  };

  if (!disableThinking) {
    body.generationConfig.thinkingConfig = isGemini3Model(model)
      ? {
          thinkingLevel: "minimal"
        }
      : {
          thinkingBudget: 0
        };
  }

  return body;
}

function extractSseData(eventBlock) {
  const dataLines = eventBlock
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  return dataLines.length ? dataLines.join("\n") : "";
}

function extractGeminiChunkText(payload) {
  const candidateTexts = (payload?.candidates || [])
    .flatMap((candidate) => {
      const texts = [];

      if (typeof candidate?.text === "string") {
        texts.push(candidate.text);
      }

      if (typeof candidate?.content?.text === "string") {
        texts.push(candidate.content.text);
      }

      if (Array.isArray(candidate?.content?.parts)) {
        for (const part of candidate.content.parts) {
          if (typeof part?.text === "string") {
            texts.push(part.text);
          }
        }
      }

      return texts;
    })
    .join("");

  return normalizeModelText(payload?.text || candidateTexts || "");
}

function parseGeminiSseChunk(eventBlock) {
  const eventData = extractSseData(eventBlock);
  if (!eventData || eventData === "[DONE]") {
    return "";
  }

  try {
    return extractGeminiChunkText(JSON.parse(eventData));
  } catch {
    return "";
  }
}

function takeNextSseEvent(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const separatorIndex = normalized.indexOf("\n\n");
  if (separatorIndex === -1) {
    return null;
  }

  const block = normalized.slice(0, separatorIndex);
  const rest = normalized.slice(separatorIndex + 2);
  return { block, rest };
}

function isGemini3Model(modelName) {
  return modelName.startsWith("gemini-3");
}

async function translateWithGemini({ apiKey, model, sourceLang, targetLang, text, disableThinking = false, signal } = {}) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(buildGeminiRequestBody(model, sourceLang, targetLang, text, { disableThinking })),
        signal
      }
    );

    if (!response.ok) {
      const bodyText = await response.text();
      throw createHttpError(`Gemini API ${response.status}: ${bodyText}`, response.status);
    }

    const data = await response.json();
    const translation = extractGeminiChunkText(data);

    if (!translation) {
      const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
      throw createTranslationError(
        "empty",
        reason
          ? `Gemini から翻訳結果を取得できませんでした (${reason})。`
          : "Gemini から翻訳結果を取得できませんでした。"
      );
    }

    return translation;
  } catch (error) {
    if (error?.code || error?.name === "AbortError") {
      throw error;
    }

    if (error instanceof TypeError) {
      throw createTranslationError("network", error.message || "Gemini への接続に失敗しました。");
    }

    throw error;
  }
}

function createTranslationError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function createHttpError(message, status) {
  return createTranslationError("http", message, { status });
}

function createAttemptSignalManager(parentSignal, { timeoutMs = 0, timeoutMessage, stallTimeoutMs = 0, stallMessage } = {}) {
  const controller = new AbortController();
  let abortError = null;
  let parentAborted = false;
  let timeoutId = null;
  let stallTimeoutId = null;

  const abortFromParent = () => {
    parentAborted = true;
    controller.abort();
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  const clearTimeouts = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (stallTimeoutId) {
      clearTimeout(stallTimeoutId);
      stallTimeoutId = null;
    }
  };

  const abortWithError = (error) => {
    if (controller.signal.aborted) {
      return;
    }
    abortError = error;
    controller.abort();
  };

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      abortWithError(createTranslationError("timeout", timeoutMessage || "翻訳の応答がタイムアウトしました。"));
    }, timeoutMs);
  }

  const touchStallTimeout = () => {
    if (stallTimeoutMs <= 0) {
      return;
    }

    if (stallTimeoutId) {
      clearTimeout(stallTimeoutId);
    }

    stallTimeoutId = setTimeout(() => {
      abortWithError(createTranslationError("stall", stallMessage || "翻訳ストリームの応答が停止しました。"));
    }, stallTimeoutMs);
  };

  return {
    signal: controller.signal,
    touchStallTimeout,
    clearStallTimeout() {
      if (!stallTimeoutId) {
        return;
      }
      clearTimeout(stallTimeoutId);
      stallTimeoutId = null;
    },
    wrapError(error) {
      if (parentAborted || parentSignal?.aborted) {
        return error;
      }
      if (abortError) {
        return abortError;
      }
      if (error instanceof TypeError) {
        return createTranslationError("network", error.message || "ネットワークエラーが発生しました。");
      }
      return error;
    },
    cleanup() {
      clearTimeouts();
      if (parentSignal) {
        parentSignal.removeEventListener("abort", abortFromParent);
      }
    }
  };
}

function buildTranslationPrompt(sourceLang, targetLang, text) {
  return [
    `You are a professional live subtitle translator.`,
    `Translate from ${labelForLanguage(sourceLang)} to ${labelForLanguage(targetLang)}.`,
    "Write natural, native-sounding subtitles for real-time viewing.",
    "Keep the meaning and tone, but prefer concise spoken phrasing over literal wording.",
    "Do not add explanations, quotes, notes, speaker labels, or extra context.",
    "If the input is fragmentary or unfinished, translate only what is present and do not complete it.",
    "If a proper noun is unclear, keep it phonetically rather than guessing.",
    "Return only the translated subtitle text.",
    "",
    text
  ].join("\n");
}

async function handleFatalError(error) {
  session.sttConnectionState = STT_CONNECTION_STATES.closed;
  debugLog("session:error", {
    sessionId: session.sessionId,
    message: error?.message || "音声処理でエラーが発生しました。"
  });
  await notifyBackground({
    type: MESSAGE_TYPES.sessionError,
    error: error?.message || "音声処理でエラーが発生しました。",
    sttTransport: session.sttTransport,
    sttConnectionState: session.sttConnectionState,
    utteranceIndex: session.utteranceIndex
  });
  await stopSession();
}

async function stopSession() {
  if (!session) {
    return;
  }

  debugLog("session:stop", {
    sessionId: session.sessionId,
    queueLength: session.translationQueue.length,
    activeTranslations: session.activeTranslationCount
  });
  session.isStopping = true;

  if (session.autoStopTimer) {
    clearTimeout(session.autoStopTimer);
  }

  if (session.keepAliveTimer) {
    clearInterval(session.keepAliveTimer);
  }

  clearSoftBoundaryTimer();

  session.xaiCurrentTurn = null;
  session.xaiPreRollChunks.length = 0;
  session.xaiTurnQueue.length = 0;
  session.isPumpingXaiTurnQueue = false;
  session.translationQueue.length = 0;
  session.activeTranslationCount = 0;
  session.isPumpingTranslationQueue = false;
  session.completedTranslations.clear();
  session.translationStreamingResults.clear();
  clearSpeculativeTranslationState();
  clearAllStreamingPartialState();

  if (session.transcriptionAbortControllers.size) {
    for (const controller of session.transcriptionAbortControllers) {
      controller.abort();
    }
    session.transcriptionAbortControllers.clear();
  }

  if (session.translationAbortControllers.size) {
    for (const controller of session.translationAbortControllers) {
      controller.abort();
    }
    session.translationAbortControllers.clear();
  }

  if (typeof session.connection?.requestClose === "function") {
    try {
      session.connection.requestClose();
    } catch {
      // ignore connection teardown noise
    }
  }

  session.recorderNode?.disconnect();
  session.silentGain?.disconnect();
  session.monitorGain?.disconnect();
  session.sourceNode?.disconnect();

  if (session.mediaStream) {
    for (const track of session.mediaStream.getTracks()) {
      track.stop();
    }
  }

  if (session.audioContext && session.audioContext.state !== "closed") {
    await session.audioContext.close();
  }

  session = createEmptySession();
}

async function reschedulePendingTimers() {
  if (session.sttProvider === STT_PROVIDERS.xai) {
    await maybeFlushPendingXaiTurn("settings-updated");
    return;
  }

  clearSoftBoundaryTimer();
  await evaluatePendingBoundaries("settings-updated");
}

function clearSoftBoundaryTimer() {
  if (session.softBoundaryTimer) {
    clearTimeout(session.softBoundaryTimer);
    session.softBoundaryTimer = null;
  }

  session.softBoundaryCandidate = null;
}

function getPendingTokens(endIndexAbsolute = session.finalWordBuffer.length) {
  return session.finalWordBuffer.slice(session.lastEmittedWordIndex, endIndexAbsolute);
}

function getPendingFinalizedText(endIndexAbsolute = session.finalWordBuffer.length) {
  return buildTranscriptFromTokens(getPendingTokens(endIndexAbsolute), session.settings?.sourceLang);
}

async function publishPreviewTranscript() {
  if (session.isStopping) {
    return;
  }

  const previewTranscript = buildPreviewTranscript();
  maybeScheduleSpeculativeTranslation(previewTranscript);

  if (!session.settings?.showSourcePreview) {
    return;
  }

  await notifyBackground({
    type: MESSAGE_TYPES.partialTranscript,
    transcript: previewTranscript,
    sttTransport: session.sttTransport,
    sttConnectionState: session.sttConnectionState,
    utteranceIndex: session.utteranceIndex
  });
}

function buildPreviewTranscript() {
  const finalizedText = getPendingFinalizedText();
  const interimTail = trimKnownPrefix(session.latestInterimTail, finalizedText);
  return mergePreviewSegments(finalizedText, interimTail, session.settings?.sourceLang);
}

function maybeScheduleSpeculativeTranslation(previewTranscript) {
  if (session.sttProvider !== STT_PROVIDERS.deepgram || session.isStopping) {
    clearSpeculativeTranslationState();
    return;
  }

  const normalizedPreview = normalizeModelText(previewTranscript);
  const translationApiKey = getTranslationApiKey(session.settings);
  const latencyProfile = getLatencyBehaviorProfile(session.settings?.latencyPreference);
  const sequenceId = session.sequenceId + 1;

  if (sequenceId !== session.nextDisplaySequenceId) {
    clearSpeculativeTranslationState(sequenceId);
    return;
  }

  if (!translationApiKey || !normalizedPreview || normalizedPreview.length < latencyProfile.deepgramSpeculativeMinChars) {
    clearSpeculativeTranslationState(sequenceId);
    return;
  }

  const speculativeState = session.speculativeTranslation;
  if (speculativeState.sequenceId !== sequenceId) {
    clearSpeculativeTranslationState();
  }

  if (
    speculativeState.sequenceId === sequenceId &&
    speculativeState.sourceText === normalizedPreview &&
    (speculativeState.debounceTimer || speculativeState.abortController || speculativeState.emittedText)
  ) {
    return;
  }

  speculativeState.version += 1;
  speculativeState.sequenceId = sequenceId;
  speculativeState.sourceText = normalizedPreview;
  speculativeState.emittedText = "";

  if (speculativeState.debounceTimer) {
    clearTimeout(speculativeState.debounceTimer);
  }

  if (speculativeState.abortController) {
    speculativeState.abortController.abort();
    speculativeState.abortController = null;
  }

  const version = speculativeState.version;
  debugLog("translation:speculative-schedule", {
    sessionId: session.sessionId,
    sequenceId,
    chars: normalizedPreview.length,
    debounceMs: latencyProfile.deepgramSpeculativeDebounceMs
  });
  speculativeState.debounceTimer = setTimeout(() => {
    speculativeState.debounceTimer = null;
    void runSpeculativeTranslation({
      sequenceId,
      sourceText: normalizedPreview,
      version
    });
  }, latencyProfile.deepgramSpeculativeDebounceMs);
}

function clearSpeculativeTranslationState(sequenceId = null) {
  const speculativeState = session.speculativeTranslation;
  if (!speculativeState) {
    return;
  }

  if (sequenceId != null && speculativeState.sequenceId !== sequenceId) {
    return;
  }

  if (speculativeState.debounceTimer) {
    clearTimeout(speculativeState.debounceTimer);
    speculativeState.debounceTimer = null;
  }

  if (speculativeState.abortController) {
    speculativeState.abortController.abort();
    speculativeState.abortController = null;
  }

  speculativeState.sequenceId = 0;
  speculativeState.sourceText = "";
  speculativeState.emittedText = "";
  speculativeState.version += 1;
}

function isCurrentSpeculativeTranslation(sequenceId, sourceText, version) {
  const speculativeState = session.speculativeTranslation;
  return (
    !session.isStopping &&
    session.sttProvider === STT_PROVIDERS.deepgram &&
    speculativeState.sequenceId === sequenceId &&
    speculativeState.sourceText === sourceText &&
    speculativeState.version === version
  );
}

async function runSpeculativeTranslation({ sequenceId, sourceText, version }) {
  if (!isCurrentSpeculativeTranslation(sequenceId, sourceText, version)) {
    return;
  }

  const translationApiKey = getTranslationApiKey(session.settings);
  if (!translationApiKey) {
    clearSpeculativeTranslationState(sequenceId);
    return;
  }

  const abortController = new AbortController();
  session.speculativeTranslation.abortController = abortController;
  let bestPartial = "";

  debugLog("translation:speculative-start", {
    sessionId: session.sessionId,
    sequenceId,
    provider: session.settings.translationProvider,
    model: session.settings.translationProvider === TRANSLATION_PROVIDERS.gemini ? getGeminiModel(session.settings) : null,
    chars: sourceText.length
  });

  try {
    const translation = await translateWithProviderAttempt({
      provider: session.settings.translationProvider,
      apiKey: translationApiKey,
      model: getGeminiModel(session.settings),
      sourceLang: session.settings.sourceLang,
      targetLang: session.settings.targetLang,
      text: sourceText,
      signal: abortController.signal,
      onPartialUpdate: async (partialTranslation) => {
        const normalized = normalizeModelText(partialTranslation);
        if (!normalized || !isCurrentSpeculativeTranslation(sequenceId, sourceText, version)) {
          return;
        }

        bestPartial = selectPreferredPartial(bestPartial, normalized);
        await emitSpeculativeTranslation(sequenceId, sourceText, bestPartial, version);
      }
    });

    const finalTranslation = normalizeModelText(translation) || bestPartial;
    if (!finalTranslation || !isCurrentSpeculativeTranslation(sequenceId, sourceText, version)) {
      return;
    }

    await emitSpeculativeTranslation(sequenceId, sourceText, finalTranslation, version);
    debugLog("translation:speculative-complete", {
      sessionId: session.sessionId,
      sequenceId,
      chars: finalTranslation.length
    });
  } catch (error) {
    if (abortController.signal.aborted || error?.name === "AbortError") {
      return;
    }

    const normalizedError = normalizeTranslationError(error);
    debugLog("translation:speculative-error", {
      sessionId: session.sessionId,
      sequenceId,
      provider: session.settings.translationProvider,
      reason: getTranslationErrorCode(normalizedError),
      status: Number.isFinite(normalizedError?.status) ? normalizedError.status : null,
      message: normalizedError.message || String(normalizedError)
    });
  } finally {
    if (session.speculativeTranslation.abortController === abortController) {
      session.speculativeTranslation.abortController = null;
    }
  }
}

async function emitSpeculativeTranslation(sequenceId, sourceText, translation, version) {
  if (!isCurrentSpeculativeTranslation(sequenceId, sourceText, version)) {
    return;
  }

  if (sequenceId !== session.nextDisplaySequenceId) {
    return;
  }

  const normalizedTranslation = normalizeModelText(translation);
  if (!normalizedTranslation || normalizedTranslation === session.speculativeTranslation.emittedText) {
    return;
  }

  session.speculativeTranslation.emittedText = normalizedTranslation;
  await notifyBackground({
    type: MESSAGE_TYPES.finalTranslation,
    translation: normalizedTranslation,
    sourceText,
    sequenceId,
    isFinal: false
  });
}

function extractFinalTokensFromPayload(payload, transcript) {
  const alternative = payload?.channel?.alternatives?.[0];
  const words = Array.isArray(alternative?.words) ? alternative.words : [];
  if (words.length > 0) {
    return words
      .map((word) => createSegmentToken(word))
      .filter((token) => Boolean(token?.displayText));
  }

  const fallbackText = normalizeModelText(transcript);
  if (!fallbackText) {
    return [];
  }

  return [
    {
      baseText: fallbackText,
      displayText: fallbackText,
      startMs: toMilliseconds(payload?.start),
      endMs: toMilliseconds((payload?.start || 0) + (payload?.duration || 0))
    }
  ];
}

function createSegmentToken(word) {
  const baseText = normalizeTokenText(word?.word);
  const displayText = normalizeTokenText(word?.punctuated_word || word?.word);
  if (!displayText) {
    return null;
  }

  return {
    baseText: baseText || displayText,
    displayText,
    startMs: toMilliseconds(word?.start),
    endMs: toMilliseconds(word?.end)
  };
}

function appendFinalWordTokens(tokens) {
  if (!tokens.length) {
    return 0;
  }

  const overlap = findTokenOverlap(session.finalWordBuffer, tokens);
  if (overlap > 0) {
    const overlapStartIndex = session.finalWordBuffer.length - overlap;
    for (let index = 0; index < overlap; index += 1) {
      session.finalWordBuffer[overlapStartIndex + index] = tokens[index];
    }
  }

  const appendedTokens = tokens.slice(overlap);
  if (!appendedTokens.length) {
    return 0;
  }

  session.finalWordBuffer.push(...appendedTokens);
  return appendedTokens.length;
}

function findTokenOverlap(existingTokens, incomingTokens) {
  if (!existingTokens.length || !incomingTokens.length) {
    return 0;
  }

  const maxOverlap = Math.min(existingTokens.length, incomingTokens.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    let matches = true;

    for (let index = 0; index < size; index += 1) {
      const existingToken = existingTokens[existingTokens.length - size + index];
      const incomingToken = incomingTokens[index];
      if (!tokensApproximatelyMatch(existingToken, incomingToken)) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return size;
    }
  }

  return 0;
}

function tokensApproximatelyMatch(leftToken, rightToken) {
  if (!leftToken || !rightToken) {
    return false;
  }

  return (
    normalizeTokenIdentity(leftToken.baseText) === normalizeTokenIdentity(rightToken.baseText) &&
    Math.abs((leftToken.startMs || 0) - (rightToken.startMs || 0)) <= TOKEN_TIME_TOLERANCE_MS &&
    Math.abs((leftToken.endMs || 0) - (rightToken.endMs || 0)) <= TOKEN_TIME_TOLERANCE_MS
  );
}

async function evaluatePendingBoundaries(trigger, { forceReason = null, utteranceEndMs = null } = {}) {
  if (session.isStopping) {
    return;
  }

  const profile = getSegmentationProfile(session.settings?.segmentationMode);

  while (!session.isStopping) {
    const pendingTokens = getPendingTokens();
    if (!pendingTokens.length) {
      clearSoftBoundaryTimer();
      await publishPreviewTranscript();
      return;
    }

    if (forceReason) {
      const forcedEndIndex =
        forceReason === "utterance-end" && Number.isFinite(utteranceEndMs)
          ? findUtteranceEndBoundaryIndex(utteranceEndMs) || session.finalWordBuffer.length
          : session.finalWordBuffer.length;
      await flushPendingTokens(forceReason, {
        endIndexAbsolute: forcedEndIndex
      });
      forceReason = null;
      utteranceEndMs = null;
      continue;
    }

    const hardBoundary = findHardBoundaryCandidate(pendingTokens);
    if (hardBoundary) {
      debugBoundaryEvent("boundary:detected", hardBoundary);
      await flushPendingTokens(hardBoundary.reason, hardBoundary);
      continue;
    }

    const watchdogBoundary = findWatchdogBoundaryCandidate(pendingTokens, profile);
    if (watchdogBoundary) {
      debugBoundaryEvent("boundary:detected", watchdogBoundary);
      await flushPendingTokens(watchdogBoundary.reason, watchdogBoundary);
      continue;
    }

    const softBoundary = findSoftBoundaryCandidate(pendingTokens, profile);
    if (softBoundary) {
      scheduleSoftBoundaryFlush(softBoundary, profile.softLookaheadMs);
    } else {
      clearSoftBoundaryTimer();
    }

    await publishPreviewTranscript();
    debugLog("boundary:idle", {
      sessionId: session.sessionId,
      trigger,
      pendingWords: pendingTokens.length
    });
    return;
  }
}

function findHardBoundaryCandidate(pendingTokens) {
  for (let index = 0; index < pendingTokens.length; index += 1) {
    if (HARD_BOUNDARY_PUNCTUATION_RE.test(getTokenRenderText(pendingTokens[index]))) {
      return createBoundaryCandidate("punctuation", session.lastEmittedWordIndex + index + 1);
    }
  }

  return null;
}

function findSoftBoundaryCandidate(pendingTokens, profile) {
  let candidate = null;

  for (let index = 0; index < pendingTokens.length; index += 1) {
    const leftWordCount = index + 1;
    if (leftWordCount < profile.minWords) {
      continue;
    }

    const token = pendingTokens[index];
    const absoluteEndIndex = session.lastEmittedWordIndex + leftWordCount;
    if (SOFT_BOUNDARY_PUNCTUATION_RE.test(getTokenRenderText(token)) && !shouldSuppressSoftBoundary(token)) {
      candidate = createBoundaryCandidate("punctuation", absoluteEndIndex);
    }

    const nextToken = pendingTokens[index + 1];
    if (!nextToken || shouldSuppressSoftBoundary(token)) {
      continue;
    }

    const gapMs = Math.max(0, (nextToken.startMs || 0) - (token.endMs || 0));
    if (gapMs >= profile.wordGapMs) {
      candidate = createBoundaryCandidate("word-gap", absoluteEndIndex, {
        gapMs
      });
    }
  }

  return candidate;
}

function findWatchdogBoundaryCandidate(pendingTokens, profile) {
  const { wordCount, durationMs } = measureTokenSpan(pendingTokens);
  if (wordCount < profile.maxWords && durationMs < profile.maxDurationMs) {
    return null;
  }

  const softCandidate = findSoftBoundaryCandidate(pendingTokens, profile);
  if (softCandidate) {
    return {
      ...softCandidate,
      reason: "watchdog"
    };
  }

  return createBoundaryCandidate("watchdog", session.finalWordBuffer.length);
}

function createBoundaryCandidate(reason, endIndexAbsolute, extra = {}) {
  const tokens = session.finalWordBuffer.slice(session.lastEmittedWordIndex, endIndexAbsolute);
  const { wordCount, durationMs } = measureTokenSpan(tokens);

  return {
    reason,
    endIndexAbsolute,
    wordCount,
    durationMs,
    gapMs: extra.gapMs ?? null
  };
}

function scheduleSoftBoundaryFlush(candidate, waitMs) {
  const currentCandidate = session.softBoundaryCandidate;
  if (
    currentCandidate &&
    currentCandidate.endIndexAbsolute === candidate.endIndexAbsolute &&
    currentCandidate.reason === candidate.reason &&
    currentCandidate.gapMs === candidate.gapMs
  ) {
    return;
  }

  clearSoftBoundaryTimer();
  session.softBoundaryCandidate = candidate;
  debugBoundaryEvent("boundary:detected", candidate);
  debugLog("boundary:deferred", {
    sessionId: session.sessionId,
    reason: candidate.reason,
    wordCount: candidate.wordCount,
    durationMs: candidate.durationMs,
    gapMs: candidate.gapMs,
    waitMs
  });
  session.softBoundaryTimer = setTimeout(() => {
    void flushDeferredSoftBoundary(candidate);
  }, waitMs);
}

async function flushDeferredSoftBoundary(candidate) {
  if (
    session.isStopping ||
    !session.softBoundaryCandidate ||
    session.softBoundaryCandidate.endIndexAbsolute !== candidate.endIndexAbsolute
  ) {
    return;
  }

  clearSoftBoundaryTimer();
  await flushPendingTokens(candidate.reason, candidate);
  await evaluatePendingBoundaries("soft-boundary-flush");
}

function findUtteranceEndBoundaryIndex(lastWordEndMs) {
  let boundaryIndex = null;

  for (let index = session.lastEmittedWordIndex; index < session.finalWordBuffer.length; index += 1) {
    const token = session.finalWordBuffer[index];
    if ((token.endMs || 0) <= lastWordEndMs + TOKEN_TIME_TOLERANCE_MS) {
      boundaryIndex = index + 1;
      continue;
    }

    if ((token.startMs || 0) > lastWordEndMs + TOKEN_TIME_TOLERANCE_MS) {
      break;
    }
  }

  return boundaryIndex;
}

async function flushPendingTokens(reason, { endIndexAbsolute = session.finalWordBuffer.length, gapMs = null } = {}) {
  const safeEndIndex = Math.max(session.lastEmittedWordIndex, Math.min(endIndexAbsolute, session.finalWordBuffer.length));
  const tokens = session.finalWordBuffer.slice(session.lastEmittedWordIndex, safeEndIndex);
  const text = buildTranscriptFromTokens(tokens, session.settings?.sourceLang);
  if (!text) {
    return;
  }

  clearSoftBoundaryTimer();

  const sequenceId = ++session.sequenceId;
  const { wordCount, durationMs } = measureTokenSpan(tokens);
  debugLog("boundary:flush", {
    sessionId: session.sessionId,
    sequenceId,
    reason,
    wordCount,
    durationMs,
    gapMs,
    queueLength: session.translationQueue.length,
    activeTranslations: session.activeTranslationCount
  });

  session.lastEmittedWordIndex = safeEndIndex;
  compactFinalWordBuffer();
  await emitFinalTranscriptSegment(text, sequenceId);
}

function enqueueTranslationTask(task) {
  session.translationQueue.push(task);
  debugLog("translation:enqueue", {
    sessionId: session.sessionId,
    sequenceId: task.sequenceId,
    provider: task.provider,
    model: task.provider === TRANSLATION_PROVIDERS.gemini ? task.model : null,
    queueLength: session.translationQueue.length,
    activeTranslations: session.activeTranslationCount
  });
  void pumpTranslationQueue(session.sessionId);
}

async function pumpTranslationQueue(sessionId) {
  if (session.isPumpingTranslationQueue) {
    return;
  }

  session.isPumpingTranslationQueue = true;

  try {
    while (
      session.sessionId === sessionId &&
      !session.isStopping &&
      session.activeTranslationCount < MAX_CONCURRENT_TRANSLATIONS &&
      session.translationQueue.length > 0
    ) {
      const task = session.translationQueue.shift();
      if (!task) {
        continue;
      }

      session.activeTranslationCount += 1;
      debugLog("translation:start", {
        sessionId,
        sequenceId: task.sequenceId,
        provider: task.provider,
        model: task.provider === TRANSLATION_PROVIDERS.gemini ? task.model : null,
        queueLength: session.translationQueue.length,
        activeTranslations: session.activeTranslationCount
      });
      void runTranslationTask(task, sessionId);
    }
  } finally {
    if (session.sessionId === sessionId) {
      session.isPumpingTranslationQueue = false;
    }
  }
}

async function runTranslationTask(task, sessionId) {
  const abortController = new AbortController();
  session.translationAbortControllers.add(abortController);
  let bestPartial = "";
  let lastError = null;
  let lastAttempt = 0;
  let didComplete = false;

  try {
    for (let attempt = 1; attempt <= TRANSLATION_MAX_ATTEMPTS; attempt += 1) {
      lastAttempt = attempt;
      if (attempt > 1) {
        const delayMs = getTranslationRetryDelayMs(task.provider);
        debugLog("translation:retry", {
          sessionId,
          sequenceId: task.sequenceId,
          provider: task.provider,
          model: task.provider === TRANSLATION_PROVIDERS.gemini ? task.model : null,
          attempt,
          delayMs,
          reason: getTranslationErrorCode(lastError),
          message: lastError?.message || null
        });
        await sleep(delayMs);
      }

      if (session.sessionId !== sessionId || session.isStopping || abortController.signal.aborted) {
        return;
      }

      try {
        const translation = await translateWithProviderAttempt({
          provider: task.provider,
          apiKey: task.apiKey,
          model: task.model,
          sourceLang: task.sourceLang,
          targetLang: task.targetLang,
          text: task.text,
          signal: abortController.signal,
          onPartialUpdate: async (partialTranslation) => {
            const normalized = normalizeModelText(partialTranslation);
            if (!normalized) {
              return;
            }

            bestPartial = selectPreferredPartial(bestPartial, normalized);
            await stageStreamingTranslationUpdate(task, normalized, sessionId);
          }
        });

        const finalTranslation = normalizeModelText(translation) || bestPartial || TRANSLATION_UNAVAILABLE_TEXT;
        await completeTranslationTask(task, sessionId, finalTranslation, {
          event: attempt > 1 ? "translation:recovered" : "translation:completed",
          attempt
        });
        didComplete = true;
        return;
      } catch (error) {
        if (abortController.signal.aborted && (session.isStopping || error?.name === "AbortError")) {
          throw error;
        }

        lastError = normalizeTranslationError(error);
        debugLog(getTranslationFailureEvent(lastError), {
          sessionId,
          sequenceId: task.sequenceId,
          provider: task.provider,
          model: task.provider === TRANSLATION_PROVIDERS.gemini ? task.model : null,
          attempt,
          reason: getTranslationErrorCode(lastError),
          status: Number.isFinite(lastError?.status) ? lastError.status : null,
          message: lastError?.message || String(lastError)
        });

        if (attempt >= TRANSLATION_MAX_ATTEMPTS || !shouldRetryTranslationError(lastError)) {
          break;
        }
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError" && session.sessionId === sessionId && !session.isStopping) {
      lastError = normalizeTranslationError(error);
    }
  } finally {
    if (session.sessionId === sessionId && !session.isStopping && !abortController.signal.aborted && !didComplete) {
      await completeTranslationTask(task, sessionId, bestPartial || TRANSLATION_UNAVAILABLE_TEXT, {
        event: "translation:fallback",
        attempt: lastAttempt || 1,
        message: lastError?.message || null,
        fallbackSource: bestPartial ? "partial" : "unavailable"
      });
    }

    session.translationAbortControllers.delete(abortController);

    if (session.sessionId === sessionId) {
      session.activeTranslationCount = Math.max(0, session.activeTranslationCount - 1);
      debugLog("translation:slot-free", {
        sessionId,
        sequenceId: task.sequenceId,
        provider: task.provider,
        model: task.provider === TRANSLATION_PROVIDERS.gemini ? task.model : null,
        queueLength: session.translationQueue.length,
        activeTranslations: session.activeTranslationCount
      });
      void pumpTranslationQueue(sessionId);
    }
  }
}

async function completeTranslationTask(task, sessionId, translation, { event, attempt, message = null, fallbackSource = null } = {}) {
  if (session.sessionId !== sessionId || session.isStopping) {
    return;
  }

  const finalTranslation = normalizeModelText(translation) || TRANSLATION_UNAVAILABLE_TEXT;
  clearStreamingPartialState(task.sequenceId);
  session.completedTranslations.set(task.sequenceId, {
    translation: finalTranslation,
    sourceText: task.text,
    provider: task.provider
  });
  session.translationStreamingResults.delete(task.sequenceId);

  debugLog(event, {
    sessionId,
    sequenceId: task.sequenceId,
    provider: task.provider,
    model: task.provider === TRANSLATION_PROVIDERS.gemini ? task.model : null,
    attempt,
    waitingForDisplay: task.sequenceId !== session.nextDisplaySequenceId,
    message,
    fallbackSource
  });

  await flushReadyTranslationResults(sessionId);
}

function normalizeTranslationError(error) {
  if (!error) {
    return createTranslationError("unknown", "翻訳処理で不明なエラーが発生しました。");
  }

  if (error.code) {
    return error;
  }

  if (error instanceof TypeError) {
    return createTranslationError("network", error.message || "ネットワークエラーが発生しました。");
  }

  return createTranslationError("unknown", error.message || String(error), {
    status: Number.isFinite(error?.status) ? error.status : null,
    cause: error
  });
}

function getTranslationErrorCode(error) {
  return error?.code || "unknown";
}

function shouldRetryTranslationError(error) {
  const code = getTranslationErrorCode(error);
  if (["timeout", "stall", "network", "empty"].includes(code)) {
    return true;
  }

  const status = Number(error?.status);
  return status === 408 || status === 429 || status >= 500;
}

function getTranslationFailureEvent(error) {
  const code = getTranslationErrorCode(error);
  if (code === "timeout") {
    return "translation:timeout";
  }
  if (code === "stall") {
    return "translation:stall";
  }
  return "translation:error";
}

function getTranslationRetryDelayMs(provider) {
  return provider === TRANSLATION_PROVIDERS.cloudTranslation
    ? CLOUD_TRANSLATION_RETRY_DELAY_MS
    : GEMINI_RETRY_DELAY_MS;
}

function selectPreferredPartial(previousText, nextText) {
  const previous = normalizeModelText(previousText);
  const next = normalizeModelText(nextText);

  if (!next) {
    return previous;
  }

  if (!previous) {
    return next;
  }

  return next.length >= previous.length ? next : previous;
}

async function flushReadyTranslationResults(sessionId) {
  if (session.sessionId !== sessionId || session.isStopping) {
    return;
  }

  while (session.completedTranslations.has(session.nextDisplaySequenceId)) {
    const readyTranslation = session.completedTranslations.get(session.nextDisplaySequenceId);
    session.completedTranslations.delete(session.nextDisplaySequenceId);
    session.translationStreamingResults.delete(session.nextDisplaySequenceId);
    session.streamingLoggedSequenceIds.delete(session.nextDisplaySequenceId);

    debugLog("translation:emit-final", {
      sessionId,
      sequenceId: session.nextDisplaySequenceId,
      provider: readyTranslation.provider
    });

    void notifyBackground({
      type: MESSAGE_TYPES.finalTranslation,
      translation: readyTranslation.translation,
      sourceText: readyTranslation.sourceText,
      sequenceId: session.nextDisplaySequenceId,
      isFinal: true
    });

    session.nextDisplaySequenceId += 1;
  }

  await flushCurrentStreamingTranslation(sessionId);
}

async function stageStreamingTranslationUpdate(task, translation, sessionId) {
  if (session.sessionId !== sessionId || session.isStopping) {
    return;
  }

  const normalized = normalizeModelText(translation);
  if (!normalized) {
    return;
  }

  const streamingState = getOrCreateStreamingPartialState(task.sequenceId);
  streamingState.rawText = normalized;

  const candidateText = selectStableStreamingText(streamingState.emittedText, normalized);
  if (!candidateText || candidateText === streamingState.emittedText) {
    return;
  }

  const now = Date.now();
  const shouldEmitImmediately =
    candidateText.length >= STREAMING_MIN_EMIT_CHARS &&
    (now - streamingState.lastEmitAt >= STREAMING_UPDATE_DEBOUNCE_MS || HARD_BOUNDARY_PUNCTUATION_RE.test(candidateText));

  if (shouldEmitImmediately) {
    await emitStreamingTranslationUpdate(task, candidateText, sessionId);
    return;
  }

  if (!streamingState.timerId) {
    streamingState.timerId = setTimeout(() => {
      void flushDeferredStreamingUpdate(task, sessionId);
    }, STREAMING_UPDATE_DEBOUNCE_MS);
  }
}

async function flushDeferredStreamingUpdate(task, sessionId) {
  const streamingState = session.streamingPartialState.get(task.sequenceId);
  if (!streamingState) {
    return;
  }

  streamingState.timerId = null;

  if (session.sessionId !== sessionId || session.isStopping) {
    return;
  }

  const candidateText = selectStableStreamingText(streamingState.emittedText, streamingState.rawText);
  if (!candidateText || candidateText === streamingState.emittedText) {
    return;
  }

  await emitStreamingTranslationUpdate(task, candidateText, sessionId);
}

async function emitStreamingTranslationUpdate(task, translation, sessionId) {
  if (session.sessionId !== sessionId || session.isStopping) {
    return;
  }

  const streamingState = getOrCreateStreamingPartialState(task.sequenceId);
  clearStreamingPartialTimer(streamingState);
  streamingState.emittedText = translation;
  streamingState.lastEmitAt = Date.now();

  session.translationStreamingResults.set(task.sequenceId, {
    translation,
    sourceText: task.text,
    provider: task.provider
  });

  if (!session.streamingLoggedSequenceIds.has(task.sequenceId)) {
    session.streamingLoggedSequenceIds.add(task.sequenceId);
    debugLog("translation:streaming", {
      sessionId,
      sequenceId: task.sequenceId,
      provider: task.provider,
      model: task.provider === TRANSLATION_PROVIDERS.gemini ? task.model : null,
      displayingNow: task.sequenceId === session.nextDisplaySequenceId
    });
  }

  if (task.sequenceId === session.nextDisplaySequenceId) {
    void notifyBackground({
      type: MESSAGE_TYPES.finalTranslation,
      translation,
      sourceText: task.text,
      sequenceId: task.sequenceId,
      isFinal: false
    });
  }
}

async function flushCurrentStreamingTranslation(sessionId) {
  if (session.sessionId !== sessionId || session.isStopping) {
    return;
  }

  const streamingTranslation = session.translationStreamingResults.get(session.nextDisplaySequenceId);
  if (!streamingTranslation?.translation) {
    if (session.completedTranslations.size > 0 || session.translationQueue.length > 0 || session.activeTranslationCount > 0) {
      debugLog("translation:waiting-head", {
        sessionId,
        nextDisplaySequenceId: session.nextDisplaySequenceId,
        queued: session.translationQueue.length,
        activeTranslations: session.activeTranslationCount,
        completedBuffered: session.completedTranslations.size
      });
    }
    return;
  }

  debugLog("translation:emit-stream", {
    sessionId,
    sequenceId: session.nextDisplaySequenceId,
    provider: streamingTranslation.provider
  });
  void notifyBackground({
    type: MESSAGE_TYPES.finalTranslation,
    translation: streamingTranslation.translation,
    sourceText: streamingTranslation.sourceText,
    sequenceId: session.nextDisplaySequenceId,
    isFinal: false
  });
}

function resetAutoStopTimer() {
  if (session.autoStopTimer) {
    clearTimeout(session.autoStopTimer);
  }

  session.autoStopTimer = setTimeout(async () => {
    debugLog("session:auto-stop", {
      sessionId: session.sessionId
    });
    await notifyBackground({
      type: MESSAGE_TYPES.sessionError,
      error: "5分以上発話を検知しなかったため停止しました。"
    });
    await stopSession();
  }, AUTO_STOP_MS);
}

function createEmptySession() {
  return {
    tabId: null,
    settings: null,
    sttProvider: STT_PROVIDERS.deepgram,
    sttTransport: STT_TRANSPORTS.websocket,
    sttConnectionState: STT_CONNECTION_STATES.idle,
    utteranceIndex: 0,
    deepgram: null,
    connection: null,
    audioContext: null,
    mediaStream: null,
    sourceNode: null,
    monitorGain: null,
    silentGain: null,
    recorderNode: null,
    keepAliveTimer: null,
    autoStopTimer: null,
    softBoundaryTimer: null,
    softBoundaryCandidate: null,
    sequenceId: 0,
    finalWordBuffer: [],
    lastEmittedWordIndex: 0,
    latestInterimTail: "",
    xaiCurrentTurn: null,
    xaiPreRollChunks: [],
    xaiTurnQueue: [],
    isPumpingXaiTurnQueue: false,
    xaiConsecutiveTurnFailures: 0,
    transcriptionAbortControllers: new Set(),
    translationQueue: [],
    activeTranslationCount: 0,
    isPumpingTranslationQueue: false,
    translationAbortControllers: new Set(),
    completedTranslations: new Map(),
    translationStreamingResults: new Map(),
    streamingPartialState: new Map(),
    speculativeTranslation: createEmptySpeculativeTranslationState(),
    nextDisplaySequenceId: 1,
    lastInterimLogAt: 0,
    streamingLoggedSequenceIds: new Set(),
    currentAudioLevel: 0,
    currentSilentForMs: 0,
    hasReceivedAudio: false,
    isStopping: false,
    runtimeSessionId: null,
    sessionId: nextSessionId++
  };
}

function createEmptySpeculativeTranslationState() {
  return {
    sequenceId: 0,
    sourceText: "",
    emittedText: "",
    version: 0,
    debounceTimer: null,
    abortController: null
  };
}

function getSegmentationProfile(mode) {
  return SEGMENTATION_PROFILES[mode] || SEGMENTATION_PROFILES.balanced;
}

function getLatencyBehaviorProfile(preference) {
  return LATENCY_BEHAVIOR_PROFILES[preference] || LATENCY_BEHAVIOR_PROFILES[DEFAULT_SETTINGS.latencyPreference];
}

function getXaiTurnProfile(mode, latencyPreference = DEFAULT_SETTINGS.latencyPreference) {
  const profile = getSegmentationProfile(mode);
  const latencyProfile = getLatencyBehaviorProfile(latencyPreference);
  return {
    silenceFlushMs: Math.max(220, profile.endpointingMs + 90 + latencyProfile.xaiSilenceOffsetMs),
    maxTurnMs: Math.max(1100, Math.round(profile.maxDurationMs * 0.72) + latencyProfile.xaiMaxTurnOffsetMs),
    preRollMs: Math.min(320, Math.max(90, profile.softLookaheadMs + 60 + latencyProfile.xaiPreRollOffsetMs))
  };
}

function mergeTranscriptBuffer(existingText, nextText) {
  const base = normalizeSpaces(existingText);
  const addition = normalizeSpaces(nextText);

  if (!base) {
    return addition;
  }

  if (!addition) {
    return base;
  }

  if (addition.startsWith(base)) {
    return addition;
  }

  if (base.endsWith(addition)) {
    return base;
  }

  const maxOverlap = Math.min(base.length, addition.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === addition.slice(0, size)) {
      return `${base}${addition.slice(size)}`.trim();
    }
  }

  const separator = /[\s([{'"“‘-]$/.test(base) || /^[\s)\]}',.!?:;"”’-]/.test(addition) ? "" : " ";
  return `${base}${separator}${addition}`.trim();
}

function normalizeSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeModelText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTokenText(text) {
  return String(text || "").trim();
}

function normalizeTokenIdentity(text) {
  return normalizeTokenText(text).toLowerCase();
}

function toMilliseconds(value) {
  return Math.max(0, Math.round(Number(value || 0) * 1000));
}

function getTokenRenderText(token) {
  return normalizeTokenText(token?.displayText || token?.baseText || "");
}

function buildTranscriptFromTokens(tokens, sourceLang) {
  if (!tokens.length) {
    return "";
  }

  if (SPACELESS_LANGUAGES.has(sourceLang)) {
    return tokens.map((token) => getTokenRenderText(token)).join("").trim();
  }

  let transcript = "";
  for (const token of tokens) {
    const tokenText = getTokenRenderText(token);
    if (!tokenText) {
      continue;
    }

    if (!transcript) {
      transcript = tokenText;
      continue;
    }

    if (/^[)\]}%.,!?;:]/.test(tokenText) || /[([{'"“‘-]$/.test(transcript)) {
      transcript += tokenText;
      continue;
    }

    transcript += ` ${tokenText}`;
  }

  return transcript.trim();
}

function trimKnownPrefix(text, knownPrefix) {
  const normalizedText = normalizeSpaces(text);
  const normalizedPrefix = normalizeSpaces(knownPrefix);

  if (!normalizedPrefix) {
    return normalizedText;
  }

  if (!normalizedText || normalizedText === normalizedPrefix) {
    return "";
  }

  if (normalizedText.startsWith(normalizedPrefix)) {
    return normalizeSpaces(normalizedText.slice(normalizedPrefix.length));
  }

  const maxOverlap = Math.min(normalizedPrefix.length, normalizedText.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (normalizedPrefix.slice(-size) === normalizedText.slice(0, size)) {
      return normalizeSpaces(normalizedText.slice(size));
    }
  }

  return normalizedText;
}

function mergePreviewSegments(finalizedText, interimTail, sourceLang) {
  const base = normalizeModelText(finalizedText);
  const tail = normalizeModelText(interimTail);
  if (!base) {
    return tail;
  }

  if (!tail) {
    return base;
  }

  if (SPACELESS_LANGUAGES.has(sourceLang)) {
    return `${base}${tail}`.trim();
  }

  return mergeTranscriptBuffer(base, tail);
}

function shouldSuppressSoftBoundary(token) {
  if (session.settings?.sourceLang !== "en") {
    return false;
  }

  const normalizedWord = normalizeTokenIdentity(token?.baseText).replace(/^[^a-z]+|[^a-z]+$/g, "");
  return ENGLISH_SOFT_BOUNDARY_CONTINUERS.has(normalizedWord);
}

function measureTokenSpan(tokens) {
  if (!tokens.length) {
    return {
      wordCount: 0,
      durationMs: 0
    };
  }

  const startMs = tokens[0]?.startMs || 0;
  const endMs = tokens[tokens.length - 1]?.endMs || startMs;
  return {
    wordCount: tokens.length,
    durationMs: Math.max(0, endMs - startMs)
  };
}

function compactFinalWordBuffer() {
  const emittedCount = session.lastEmittedWordIndex;
  if (emittedCount < BUFFER_COMPACT_THRESHOLD) {
    return;
  }

  session.finalWordBuffer.splice(0, emittedCount);
  session.lastEmittedWordIndex = 0;

  if (session.softBoundaryCandidate) {
    session.softBoundaryCandidate = {
      ...session.softBoundaryCandidate,
      endIndexAbsolute: Math.max(0, session.softBoundaryCandidate.endIndexAbsolute - emittedCount)
    };
  }
}

function debugBoundaryEvent(event, candidate) {
  debugLog(event, {
    sessionId: session.sessionId,
    reason: candidate.reason,
    wordCount: candidate.wordCount,
    durationMs: candidate.durationMs,
    gapMs: candidate.gapMs
  });
}

function mapDeepgramLanguage(language) {
  const mapping = {
    en: "en",
    ja: "ja",
    zh: "zh-CN"
  };

  return mapping[language] || language;
}

function mapXaiLanguage(language) {
  const mapping = {
    en: "en",
    ja: "ja"
  };

  return mapping[language] || "";
}

function labelForLanguage(language) {
  const mapping = {
    en: "English",
    ja: "Japanese",
    zh: "Simplified Chinese"
  };

  return mapping[language] || language;
}

function mapTranslationLanguage(provider, language) {
  if (provider === TRANSLATION_PROVIDERS.cloudTranslation) {
    const mapping = {
      en: "en",
      ja: "ja",
      zh: "zh-CN"
    };

    return mapping[language] || language;
  }

  return language;
}

function getTranslationApiKey(settings) {
  if (settings.translationProvider === TRANSLATION_PROVIDERS.cloudTranslation) {
    return settings.cloudTranslationApiKey;
  }

  return settings.geminiApiKey;
}

function getSttProvider(settings) {
  const providerValue = String(
    settings?.sttProvider ??
      settings?.speechProvider ??
      settings?.transcriptionProvider ??
      settings?.sttEngine ??
      ""
  )
    .trim()
    .toLowerCase();

  return XAI_PROVIDER_ALIASES.has(providerValue) ? STT_PROVIDERS.xai : STT_PROVIDERS.deepgram;
}

function getXaiApiKey(settings) {
  return (
    settings?.xaiApiKey ||
    settings?.grokApiKey ||
    settings?.sttApiKey ||
    settings?.speechApiKey ||
    ""
  );
}

function getSttTransport(settings) {
  if (getSttProvider(settings) === STT_PROVIDERS.xai) {
    return STT_TRANSPORTS.https;
  }

  return STT_TRANSPORTS.websocket;
}

function getSessionStartingMessage(provider, transport) {
  if (provider === STT_PROVIDERS.xai) {
    return "xAI 音声認識を準備しています…";
  }

  return "Deepgram に接続しています…";
}

function getSpeechDetectedMessage(provider, transport) {
  return provider === STT_PROVIDERS.xai
    ? "タブ音声ストリームを受信しました。発話区切りを監視しています…"
    : "タブ音声を検出しました。文字起こしを待っています…";
}

function getGeminiModel(settings) {
  return settings?.geminiModel || DEFAULT_SETTINGS.geminiModel;
}

function decodeHtmlEntities(text) {
  htmlEntityDecoder.innerHTML = String(text || "");
  return htmlEntityDecoder.value;
}

function cloneAudioBuffer(audioBuffer) {
  return audioBuffer instanceof ArrayBuffer ? audioBuffer.slice(0) : new ArrayBuffer(0);
}

function getPcmDurationMs(audioBuffer) {
  return Math.max(0, Math.round((audioBuffer.byteLength / PCM_BYTES_PER_SAMPLE / TARGET_SAMPLE_RATE) * 1000));
}

function mergePcmChunks(chunks) {
  const sampleCount = chunks.reduce(
    (total, chunk) => total + Math.floor((chunk?.audioBuffer?.byteLength || 0) / PCM_BYTES_PER_SAMPLE),
    0
  );
  if (!sampleCount) {
    return new ArrayBuffer(0);
  }

  const mergedBuffer = new ArrayBuffer(sampleCount * PCM_BYTES_PER_SAMPLE);
  const mergedView = new DataView(mergedBuffer);
  let byteOffset = 0;

  for (const chunk of chunks) {
    const samples = new Int16Array(chunk.audioBuffer);
    for (let index = 0; index < samples.length; index += 1) {
      mergedView.setInt16(byteOffset, samples[index], true);
      byteOffset += PCM_BYTES_PER_SAMPLE;
    }
  }

  return mergedBuffer;
}

function getOrCreateStreamingPartialState(sequenceId) {
  let streamingState = session.streamingPartialState.get(sequenceId);
  if (!streamingState) {
    streamingState = {
      rawText: "",
      emittedText: "",
      lastEmitAt: 0,
      timerId: null
    };
    session.streamingPartialState.set(sequenceId, streamingState);
  }

  return streamingState;
}

function clearStreamingPartialTimer(streamingState) {
  if (streamingState?.timerId) {
    clearTimeout(streamingState.timerId);
    streamingState.timerId = null;
  }
}

function clearStreamingPartialState(sequenceId) {
  const streamingState = session.streamingPartialState.get(sequenceId);
  if (!streamingState) {
    return;
  }

  clearStreamingPartialTimer(streamingState);
  session.streamingPartialState.delete(sequenceId);
}

function clearAllStreamingPartialState() {
  for (const streamingState of session.streamingPartialState.values()) {
    clearStreamingPartialTimer(streamingState);
  }

  session.streamingPartialState.clear();
}

async function emitFinalTranscriptSegment(text, sequenceId = ++session.sequenceId, metadata = {}) {
  const transcript = normalizeModelText(text);
  if (!transcript || session.isStopping) {
    return;
  }

  debugLog("transcript:emit-final", {
    sessionId: session.sessionId,
    sequenceId,
    sttProvider: session.sttProvider,
    chars: transcript.length
  });

  void notifyBackground({
    type: MESSAGE_TYPES.finalTranscript,
    transcript,
    sequenceId,
    sttTransport: session.sttTransport,
    sttConnectionState: session.sttConnectionState,
    utteranceIndex: session.utteranceIndex,
    providerEvent: metadata.providerEvent || null,
    isUtteranceFinal: Boolean(metadata.isUtteranceFinal)
  });

  clearSpeculativeTranslationState(sequenceId);
  enqueueTranslationTask({
    sequenceId,
    text: transcript,
    provider: session.settings.translationProvider,
    model: getGeminiModel(session.settings),
    sourceLang: session.settings.sourceLang,
    targetLang: session.settings.targetLang,
    apiKey: getTranslationApiKey(session.settings)
  });
}

function createTranscriptionError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function normalizeTranscriptionError(error) {
  if (!error) {
    return createTranscriptionError("unknown", "文字起こし処理で不明なエラーが発生しました。");
  }

  if (error.code) {
    return error;
  }

  if (error instanceof TypeError) {
    return createTranscriptionError("network", error.message || "xAI への接続に失敗しました。");
  }

  return createTranscriptionError("unknown", error.message || String(error), {
    status: Number.isFinite(error?.status) ? error.status : null,
    cause: error
  });
}

function getTranscriptionErrorCode(error) {
  return error?.code || "unknown";
}

function isRetryableTranscriptionStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isSkippableTranscriptionStatus(status) {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function shouldRetryTranscriptionError(error) {
  const code = getTranscriptionErrorCode(error);
  if (["timeout", "network", "empty"].includes(code)) {
    return true;
  }

  const status = Number(error?.status);
  return isRetryableTranscriptionStatus(status);
}

function shouldSkipTranscriptionError(error) {
  const code = getTranscriptionErrorCode(error);
  if (["timeout", "network", "empty"].includes(code)) {
    return true;
  }

  const status = Number(error?.status);
  return isSkippableTranscriptionStatus(status);
}

async function handleSkippedXaiTurn(error, sessionId) {
  session.xaiConsecutiveTurnFailures += 1;
  const consecutiveFailures = session.xaiConsecutiveTurnFailures;
  const reason = getTranscriptionErrorCode(error);
  const status = Number.isFinite(error?.status) ? error.status : null;

  debugLog("xai:skip-turn", {
    sessionId,
    reason,
    status,
    consecutiveFailures,
    message: error?.message || String(error)
  });

  if (consecutiveFailures >= 3) {
    await handleFatalError(
      createTranscriptionError(
        "unavailable",
        "xAI の文字起こしに連続で失敗しました。API キー、ネットワーク、利用制限を確認してください。",
        { status }
      )
    );
    return;
  }

  await notifyBackground({
    type: MESSAGE_TYPES.sessionStatusChanged,
    status: SESSION_STATUS.active,
    message: getXaiTurnFailureMessage(error, consecutiveFailures),
    sttTransport: session.sttTransport,
    sttConnectionState: session.sttConnectionState,
    utteranceIndex: session.utteranceIndex
  });
}

function getXaiTurnFailureMessage(error, consecutiveFailures) {
  const parts = [];
  const code = getTranscriptionErrorCode(error);
  const status = Number.isFinite(error?.status) ? error.status : null;

  if (code && code !== "unknown") {
    parts.push(code);
  }

  if (status != null) {
    parts.push(`HTTP ${status}`);
  }

  const detail = parts.length ? ` (${parts.join(" / ")})` : "";
  return `xAI の文字起こしに一時失敗しました${detail}。次の区間で再試行します… (${consecutiveFailures}/3)`;
}

async function maybeFlushPendingXaiTurn(reason) {
  if (session.sttProvider !== STT_PROVIDERS.xai || !session.xaiCurrentTurn) {
    return;
  }

  const flushReason = getXaiTurnFlushReason(getXaiTurnProfile(session.settings?.segmentationMode, session.settings?.latencyPreference));
  if (flushReason) {
    await flushCurrentXaiTurn(`${reason}:${flushReason}`);
    return;
  }

  if (session.xaiCurrentTurn.speechMs >= XAI_MIN_SPEECH_MS) {
    await flushCurrentXaiTurn(`${reason}:force`);
  }
}

function selectStableStreamingText(previousText, nextText) {
  const previous = normalizeModelText(previousText);
  const next = normalizeModelText(nextText);

  if (!next) {
    return "";
  }

  if (!previous) {
    return next;
  }

  if (next.startsWith(previous)) {
    return next;
  }

  if (previous.startsWith(next)) {
    return "";
  }

  const sharedPrefixLength = getSharedPrefixLength(previous, next);
  const similarityRatio = sharedPrefixLength / Math.max(previous.length, 1);
  if (similarityRatio >= 0.75 && next.length >= previous.length) {
    return next;
  }

  return "";
}

function getSharedPrefixLength(leftText, rightText) {
  const maxLength = Math.min(leftText.length, rightText.length);
  let index = 0;

  while (index < maxLength && leftText[index] === rightText[index]) {
    index += 1;
  }

  return index;
}

async function notifyBackground(message) {
  const payload = buildBackgroundMessage(message);

  if (!GUARDED_BACKGROUND_MESSAGE_TYPES.has(message.type)) {
    return sendBackgroundMessage(payload);
  }

  return enqueueGuardedBackgroundMessage(payload);
}

function buildBackgroundMessage(message) {
  const runtimeSessionId = message.runtimeSessionId ?? session.runtimeSessionId;

  if (runtimeSessionId == null) {
    return {
      recipient: "background",
      ...message
    };
  }

  return {
    recipient: "background",
    runtimeSessionId,
    ...message
  };
}

function enqueueGuardedBackgroundMessage(message) {
  return new Promise((resolve) => {
    backgroundDeliveryQueue.push({
      attempts: 0,
      message,
      resolve
    });
    void pumpBackgroundDeliveryQueue();
  });
}

async function pumpBackgroundDeliveryQueue() {
  if (isPumpingBackgroundDeliveryQueue) {
    return;
  }

  isPumpingBackgroundDeliveryQueue = true;

  try {
    while (backgroundDeliveryQueue.length) {
      const entry = backgroundDeliveryQueue[0];
      const delivered = await sendBackgroundMessage(entry.message);
      if (delivered) {
        backgroundDeliveryQueue.shift();
        entry.resolve(true);
        continue;
      }

      entry.attempts += 1;
      if (entry.attempts >= BACKGROUND_DELIVERY_MAX_ATTEMPTS) {
        debugLog("background:drop", {
          attempts: entry.attempts,
          runtimeSessionId: entry.message.runtimeSessionId || null,
          type: entry.message.type
        });
        backgroundDeliveryQueue.shift();
        entry.resolve(false);
        continue;
      }

      await sleep(BACKGROUND_DELIVERY_RETRY_BASE_MS * entry.attempts);
    }
  } finally {
    isPumpingBackgroundDeliveryQueue = false;
    if (backgroundDeliveryQueue.length) {
      void pumpBackgroundDeliveryQueue();
    }
  }
}

async function sendBackgroundMessage(message) {
  try {
    await chrome.runtime.sendMessage(message);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function maybeLogInterimProgress() {
  const now = Date.now();
  if (now - session.lastInterimLogAt < 1500) {
    return;
  }

  session.lastInterimLogAt = now;
  debugLog("deepgram:interim", {
    sessionId: session.sessionId,
    liveChars: session.latestInterimTail.length,
    pendingWords: getPendingTokens().length,
    silentForMs: session.currentSilentForMs
  });
}

function debugLog(event, details = {}) {
  runtimeLogger(event, details);
}
