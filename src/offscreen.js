import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { DEFAULT_SETTINGS, MESSAGE_TYPES, SESSION_STATUS, TRANSLATION_PROVIDERS } from "./constants.js";

const DEEPGRAM_MODEL = "nova-3";
const CLOUD_TRANSLATION_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const TARGET_SAMPLE_RATE = 16000;
const KEEP_ALIVE_MS = 8000;
const AUTO_STOP_MS = 5 * 60 * 1000;
const GEMINI_MAX_OUTPUT_TOKENS = 64;
const MAX_CONCURRENT_TRANSLATIONS = 2;
const TRANSLATION_UNAVAILABLE_TEXT = "翻訳を取得できませんでした。";
const DEBUG_LOG_PREFIX = "[deepfram/offscreen]";
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

let nextSessionId = 1;
let session = createEmptySession();

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

async function startSession({ tabId, streamId, settings }) {
  await stopSession();

  session = createEmptySession();
  session.tabId = tabId;
  session.settings = settings;
  session.deepgram = createClient(settings.deepgramApiKey);
  debugLog("session:start", {
    sessionId: session.sessionId,
    tabId,
    translationProvider: settings.translationProvider,
    geminiModel: settings.translationProvider === TRANSLATION_PROVIDERS.gemini ? getGeminiModel(settings) : null,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    segmentationMode: settings.segmentationMode
  });

  await notifyBackground({
    type: MESSAGE_TYPES.sessionStatusChanged,
    status: SESSION_STATUS.starting,
    message: "Deepgram に接続しています…"
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
      if (!session.connection || !event.data?.audioBuffer) {
        return;
      }

      session.currentAudioLevel = Number(event.data.level || 0);
      session.currentSilentForMs = Number(event.data.silentForMs || 0);

      if (!session.hasReceivedAudio) {
        session.hasReceivedAudio = true;
        debugLog("audio:detected", {
          sessionId: session.sessionId,
          sampleRate: TARGET_SAMPLE_RATE
        });
        notifyBackground({
          type: MESSAGE_TYPES.sessionStatusChanged,
          status: SESSION_STATUS.active,
          message: "タブ音声を検出しました。文字起こしを待っています…"
        });
      }

      session.connection.send(event.data.audioBuffer);
    };

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
    resetAutoStopTimer();
  } catch (error) {
    await handleFatalError(error);
    throw error;
  }
}

function bindDeepgramEvents(connection) {
  connection.on(LiveTranscriptionEvents.Open, async () => {
    debugLog("deepgram:open", {
      sessionId: session.sessionId
    });
    session.keepAliveTimer = setInterval(() => {
      connection.keepAlive();
    }, KEEP_ALIVE_MS);

    await notifyBackground({
      type: MESSAGE_TYPES.sessionStatusChanged,
      status: SESSION_STATUS.active,
      message: "字幕生成中"
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
  debugLog("session:error", {
    sessionId: session.sessionId,
    message: error?.message || "音声処理でエラーが発生しました。"
  });
  await notifyBackground({
    type: MESSAGE_TYPES.sessionError,
    error: error?.message || "音声処理でエラーが発生しました。"
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

  session.translationQueue.length = 0;
  session.activeTranslationCount = 0;
  session.isPumpingTranslationQueue = false;
  session.completedTranslations.clear();
  session.translationStreamingResults.clear();
  clearAllStreamingPartialState();

  if (session.translationAbortControllers.size) {
    for (const controller of session.translationAbortControllers) {
      controller.abort();
    }
    session.translationAbortControllers.clear();
  }

  if (session.connection) {
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
  if (!session.settings?.showSourcePreview || session.isStopping) {
    return;
  }

  await notifyBackground({
    type: MESSAGE_TYPES.partialTranscript,
    transcript: buildPreviewTranscript()
  });
}

function buildPreviewTranscript() {
  const finalizedText = getPendingFinalizedText();
  const interimTail = trimKnownPrefix(session.latestInterimTail, finalizedText);
  return mergePreviewSegments(finalizedText, interimTail, session.settings?.sourceLang);
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

  await notifyBackground({
    type: MESSAGE_TYPES.finalTranscript,
    transcript: text,
    sequenceId
  });

  enqueueTranslationTask({
    sequenceId,
    text,
    provider: session.settings.translationProvider,
    model: getGeminiModel(session.settings),
    sourceLang: session.settings.sourceLang,
    targetLang: session.settings.targetLang,
    apiKey: getTranslationApiKey(session.settings)
  });
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

    await notifyBackground({
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
    await notifyBackground({
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
  await notifyBackground({
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
    translationQueue: [],
    activeTranslationCount: 0,
    isPumpingTranslationQueue: false,
    translationAbortControllers: new Set(),
    completedTranslations: new Map(),
    translationStreamingResults: new Map(),
    streamingPartialState: new Map(),
    nextDisplaySequenceId: 1,
    lastInterimLogAt: 0,
    streamingLoggedSequenceIds: new Set(),
    currentAudioLevel: 0,
    currentSilentForMs: 0,
    hasReceivedAudio: false,
    isStopping: false,
    sessionId: nextSessionId++
  };
}

function getSegmentationProfile(mode) {
  return SEGMENTATION_PROFILES[mode] || SEGMENTATION_PROFILES.balanced;
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

function getGeminiModel(settings) {
  return settings?.geminiModel || DEFAULT_SETTINGS.geminiModel;
}

function decodeHtmlEntities(text) {
  htmlEntityDecoder.innerHTML = String(text || "");
  return htmlEntityDecoder.value;
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
  try {
    await chrome.runtime.sendMessage({
      recipient: "background",
      ...message
    });
  } catch {
    // service worker may be waking up
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
  console.info(DEBUG_LOG_PREFIX, event, details);
}
