import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { MESSAGE_TYPES, SESSION_STATUS } from "./constants.js";

const DEEPGRAM_MODEL = "nova-3";
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const TARGET_SAMPLE_RATE = 16000;
const KEEP_ALIVE_MS = 8000;
const AUTO_STOP_MS = 5 * 60 * 1000;
const GEMINI_MAX_OUTPUT_TOKENS = 64;
const GEMINI_RETRY_DELAYS_MS = [180, 520];
const TRANSLATION_UNAVAILABLE_TEXT = "翻訳を取得できませんでした。";
const SEGMENTATION_PROFILES = {
  latency: {
    endpointingMs: 160,
    localSilenceMs: 180,
    debounceMs: 180,
    minChars: 4,
    maxHoldMs: 700
  },
  balanced: {
    endpointingMs: 220,
    localSilenceMs: 320,
    debounceMs: 280,
    minChars: 8,
    maxHoldMs: 900
  },
  natural: {
    endpointingMs: 320,
    localSilenceMs: 500,
    debounceMs: 420,
    minChars: 12,
    maxHoldMs: 1300
  }
};

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
      reschedulePendingTimers();
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
        notifyBackground({
          type: MESSAGE_TYPES.sessionStatusChanged,
          status: SESSION_STATUS.active,
          message: "タブ音声を検出しました。文字起こしを待っています…"
        });
      }

      maybeFlushFromLocalSilence();
      session.connection.send(event.data.audioBuffer);
    };

    const segmentationProfile = getSegmentationProfile(settings.segmentationMode);
    session.connection = session.deepgram.listen.live({
      model: DEEPGRAM_MODEL,
      language: mapDeepgramLanguage(settings.sourceLang),
      punctuate: true,
      smart_format: true,
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
    const transcript = payload?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) {
      return;
    }

    resetAutoStopTimer();

    if (!payload.is_final) {
      if (session.settings.showSourcePreview) {
        await notifyBackground({
          type: MESSAGE_TYPES.partialTranscript,
          transcript: mergeTranscriptBuffer(session.pendingTranscriptText, transcript)
        });
      }
      return;
    }

    session.pendingTranscriptText = mergeTranscriptBuffer(session.pendingTranscriptText, transcript);
    if (!session.pendingStartedAt) {
      session.pendingStartedAt = Date.now();
    }
    await notifyBackground({
      type: MESSAGE_TYPES.finalTranscript,
      transcript: session.pendingTranscriptText,
      sequenceId: session.sequenceId + 1
    });

    if (payload.speech_final) {
      await flushPendingTranscript("speech-final");
      return;
    }

    if (endsWithSentenceBoundary(session.pendingTranscriptText)) {
      schedulePunctuationFlush();
    } else {
      maybeFlushFromLocalSilence();
      scheduleMaxHoldFlush();
    }
  });

  connection.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
    await flushPendingTranscript("utterance-end");
  });

  connection.on(LiveTranscriptionEvents.Error, async (error) => {
    await handleFatalError(error);
  });

  connection.on(LiveTranscriptionEvents.Close, async () => {
    if (session.isStopping) {
      return;
    }

    await notifyBackground({
      type: MESSAGE_TYPES.sessionStatusChanged,
      status: SESSION_STATUS.error,
      message: "Deepgram 接続が終了しました。"
    });
  });
}

async function streamTranslateWithGemini({ apiKey, sourceLang, targetLang, text, signal, onUpdate }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(buildGeminiRequestBody(sourceLang, targetLang, text)),
      signal
    }
  );

  if (!response.ok) {
    const bodyText = await response.text();
    if (response.status === 400 || response.status === 404) {
      const fallbackText = await translateWithGemini({ apiKey, sourceLang, targetLang, text, disableThinking: true });
      await onUpdate(fallbackText, true);
      return fallbackText;
    }

    throw new Error(`Gemini API ${response.status}: ${bodyText}`);
  }

  if (!response.body) {
    throw new Error("Gemini のストリーム応答を取得できませんでした。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assembledText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let eventBlock;
    while ((eventBlock = takeNextSseEvent(buffer))) {
      buffer = eventBlock.rest;
      const chunkText = parseGeminiSseChunk(eventBlock.block);
      if (!chunkText) {
        continue;
      }

      assembledText += chunkText;
      await onUpdate(assembledText.trimStart(), false);
    }
  }

  const trailingChunk = parseGeminiSseChunk(buffer);
  if (trailingChunk) {
    assembledText += trailingChunk;
  }

  assembledText = assembledText.trim();
  if (!assembledText) {
    const fallbackText = await translateWithGemini({ apiKey, sourceLang, targetLang, text });
    await onUpdate(fallbackText, true);
    return fallbackText;
  }

  await onUpdate(assembledText, true);
  return assembledText;
}

async function translateWithGeminiBestEffort({ apiKey, sourceLang, targetLang, text, signal, onUpdate }) {
  let lastError = null;
  let latestPartial = "";

  const trackUpdate = async (translation, isFinal) => {
    const normalized = normalizeModelText(translation);
    if (normalized) {
      latestPartial = normalized;
    }
    await onUpdate(normalized || translation, isFinal);
  };

  try {
    return await streamTranslateWithGemini({
      apiKey,
      sourceLang,
      targetLang,
      text,
      signal,
      onUpdate: trackUpdate
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    lastError = error;
  }

  for (const delayMs of GEMINI_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const translation = await translateWithGemini({
        apiKey,
        sourceLang,
        targetLang,
        text,
        disableThinking: true,
        signal
      });
      await trackUpdate(translation, true);
      return translation;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      lastError = error;
    }
  }

  if (latestPartial) {
    await onUpdate(latestPartial, true);
    return latestPartial;
  }

  throw lastError || new Error("Gemini から翻訳結果を取得できませんでした。");
}

function buildGeminiRequestBody(sourceLang, targetLang, text, { disableThinking = false } = {}) {
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
    body.generationConfig.thinkingConfig = isGemini3Model(GEMINI_MODEL)
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

async function translateWithGemini({ apiKey, sourceLang, targetLang, text, disableThinking = false, signal } = {}) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildGeminiRequestBody(sourceLang, targetLang, text, { disableThinking })),
      signal
    }
  );

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Gemini API ${response.status}: ${bodyText}`);
  }

  const data = await response.json();
  const translation = extractGeminiChunkText(data);

  if (!translation) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(
      reason
        ? `Gemini から翻訳結果を取得できませんでした (${reason})。`
        : "Gemini から翻訳結果を取得できませんでした。"
    );
  }

  return translation;
}

function buildTranslationPrompt(sourceLang, targetLang, text) {
  return [
    `Live subtitle translation: ${labelForLanguage(sourceLang)} -> ${labelForLanguage(targetLang)}.`,
    "Return only the translated subtitle text.",
    "",
    text
  ].join("\n");
}

async function handleFatalError(error) {
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

  session.isStopping = true;

  if (session.autoStopTimer) {
    clearTimeout(session.autoStopTimer);
  }

  if (session.keepAliveTimer) {
    clearInterval(session.keepAliveTimer);
  }

  if (session.translationFlushTimer) {
    clearTimeout(session.translationFlushTimer);
  }

  if (session.maxHoldFlushTimer) {
    clearTimeout(session.maxHoldFlushTimer);
  }

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

function schedulePunctuationFlush() {
  const profile = getSegmentationProfile(session.settings?.segmentationMode);
  if (session.translationFlushTimer) {
    clearTimeout(session.translationFlushTimer);
  }

  session.translationFlushTimer = setTimeout(() => {
    void flushPendingTranscript("punctuation-debounce");
  }, profile.debounceMs);
  scheduleMaxHoldFlush();
}

function scheduleMaxHoldFlush() {
  if (!session.pendingStartedAt) {
    return;
  }

  const profile = getSegmentationProfile(session.settings?.segmentationMode);
  const elapsed = Date.now() - session.pendingStartedAt;
  const remaining = Math.max(0, profile.maxHoldMs - elapsed);

  if (session.maxHoldFlushTimer) {
    clearTimeout(session.maxHoldFlushTimer);
  }

  session.maxHoldFlushTimer = setTimeout(() => {
    void flushPendingTranscript("max-hold");
  }, remaining);
}

function reschedulePendingTimers() {
  if (!session.pendingTranscriptText.trim()) {
    return;
  }

  if (endsWithSentenceBoundary(session.pendingTranscriptText)) {
    schedulePunctuationFlush();
    return;
  }

  maybeFlushFromLocalSilence();
  scheduleMaxHoldFlush();
}

function maybeFlushFromLocalSilence() {
  const text = session.pendingTranscriptText.trim();
  if (!text) {
    return;
  }

  const profile = getSegmentationProfile(session.settings?.segmentationMode);
  if (text.length < profile.minChars) {
    return;
  }

  if (session.currentSilentForMs < profile.localSilenceMs) {
    return;
  }

  void flushPendingTranscript("local-silence");
}

async function flushPendingTranscript() {
  const text = session.pendingTranscriptText.trim();
  if (!text) {
    return;
  }

  if (session.translationFlushTimer) {
    clearTimeout(session.translationFlushTimer);
    session.translationFlushTimer = null;
  }

  if (session.maxHoldFlushTimer) {
    clearTimeout(session.maxHoldFlushTimer);
    session.maxHoldFlushTimer = null;
  }

  const sequenceId = ++session.sequenceId;
  session.pendingTranscriptText = "";
  session.pendingStartedAt = 0;

  await notifyBackground({
    type: MESSAGE_TYPES.finalTranscript,
    transcript: text,
    sequenceId
  });

  const abortController = new AbortController();
  session.translationAbortControllers.add(abortController);
  session.latestTranslationRequestId = sequenceId;

  try {
    await translateWithGeminiBestEffort({
      apiKey: session.settings.geminiApiKey,
      sourceLang: session.settings.sourceLang,
      targetLang: session.settings.targetLang,
      text,
      signal: abortController.signal,
      onUpdate: async (translation, isFinal) => {
        if (sequenceId !== session.latestTranslationRequestId) {
          return;
        }

        await notifyBackground({
          type: MESSAGE_TYPES.finalTranslation,
          translation,
          sourceText: text,
          sequenceId,
          isFinal
        });
      }
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }

    await notifyBackground({
      type: MESSAGE_TYPES.finalTranslation,
      translation: TRANSLATION_UNAVAILABLE_TEXT,
      sourceText: text,
      sequenceId,
      isFinal: true
    });
  } finally {
    session.translationAbortControllers.delete(abortController);
  }
}

function resetAutoStopTimer() {
  if (session.autoStopTimer) {
    clearTimeout(session.autoStopTimer);
  }

  session.autoStopTimer = setTimeout(async () => {
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
    translationFlushTimer: null,
    maxHoldFlushTimer: null,
    latestTranslationRequestId: 0,
    sequenceId: 0,
    pendingTranscriptText: "",
    pendingStartedAt: 0,
    translationAbortControllers: new Set(),
    currentAudioLevel: 0,
    currentSilentForMs: 0,
    hasReceivedAudio: false,
    isStopping: false
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

function endsWithSentenceBoundary(text) {
  return /[.!?。！？]$/.test(text.trim());
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
