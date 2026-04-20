import {
  DEFAULT_SETTINGS,
  RUNTIME_LOG_MAX_ENTRIES_PER_SOURCE,
  RUNTIME_LOG_RETURN_LIMIT,
  RUNTIME_LOG_SOURCES,
  SESSION_STATUS,
  STORAGE_KEYS
} from "./constants.js";

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return {
    ...DEFAULT_SETTINGS,
    ...(result[STORAGE_KEYS.settings] || {})
  };
}

export async function saveSettings(settings) {
  const nextSettings = {
    ...DEFAULT_SETTINGS,
    ...settings
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: nextSettings
  });

  return nextSettings;
}

export async function getSessionState() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.sessionState);
  return (
    result[STORAGE_KEYS.sessionState] || {
      status: SESSION_STATUS.idle,
      activeTabId: null,
      runtimeSessionId: null,
      sttProvider: null,
      sttTransport: null,
      sttConnectionState: "idle",
      utteranceIndex: 0,
      translationProvider: null,
      geminiModel: null,
      sourceLang: null,
      targetLang: null,
      message: "停止中"
    }
  );
}

export async function saveSessionState(sessionState) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.sessionState]: sessionState
  });

  return sessionState;
}

const RUNTIME_LOG_STORAGE_KEYS = {
  [RUNTIME_LOG_SOURCES.background]: STORAGE_KEYS.runtimeLogsBackground,
  [RUNTIME_LOG_SOURCES.offscreen]: STORAGE_KEYS.runtimeLogsOffscreen
};

export async function appendRuntimeLogs(source, entries) {
  const storageKey = getRuntimeLogStorageKey(source);
  const normalizedEntries = normalizeRuntimeLogEntries(entries);
  if (!normalizedEntries.length) {
    return [];
  }

  const result = await chrome.storage.local.get(storageKey);
  const currentEntries = normalizeRuntimeLogEntries(result[storageKey]);
  const nextEntries = [...currentEntries, ...normalizedEntries].slice(-RUNTIME_LOG_MAX_ENTRIES_PER_SOURCE);

  await chrome.storage.local.set({
    [storageKey]: nextEntries
  });

  return nextEntries;
}

export async function getRuntimeLogs({ limit = RUNTIME_LOG_RETURN_LIMIT } = {}) {
  const storageKeys = Object.values(RUNTIME_LOG_STORAGE_KEYS);
  const result = await chrome.storage.local.get(storageKeys);
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : RUNTIME_LOG_RETURN_LIMIT;
  const mergedEntries = storageKeys
    .flatMap((storageKey) => normalizeRuntimeLogEntries(result[storageKey]))
    .sort((left, right) => {
      if (left.timestamp === right.timestamp) {
        return String(left.id || "").localeCompare(String(right.id || ""));
      }

      return left.timestamp - right.timestamp;
    });

  return mergedEntries.slice(-normalizedLimit);
}

function getRuntimeLogStorageKey(source) {
  const storageKey = RUNTIME_LOG_STORAGE_KEYS[source];
  if (!storageKey) {
    throw new Error(`Unknown runtime log source: ${source}`);
  }

  return storageKey;
}

function normalizeRuntimeLogEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.filter((entry) =>
    entry &&
    typeof entry === "object" &&
    typeof entry.source === "string" &&
    typeof entry.event === "string" &&
    Number.isFinite(entry.timestamp)
  );
}

export async function clearRuntimeLogs() {
  await chrome.storage.local.remove(Object.values(RUNTIME_LOG_STORAGE_KEYS));
}
