import { RUNTIME_LOG_FLUSH_DELAY_MS } from "./constants.js";
import { appendRuntimeLogs } from "./storage.js";

const SECRET_FIELD_RE = /(api.?key|authorization|token|secret|password)/i;
const SECRET_VALUE_RE = /\bBearer\s+[A-Za-z0-9._~-]+\b/gi;
const SECRET_ASSIGNMENT_RE = /((?:api[_-]?key|authorization|token|secret|password)["']?\s*[:=]\s*["']?)[^"',\s]+/gi;
const MAX_DEPTH = 4;
const MAX_KEYS = 16;
const MAX_ARRAY_ITEMS = 8;
const MAX_STRING_LENGTH = 240;
const IMMEDIATE_FLUSH_EVENT_RE = /(^session:|:error$|^background:drop$)/;
const PERSIST_INTERVAL_BY_EVENT = new Map([
  ["deepgram:interim", 5000],
  ["translation:streaming", 2000],
  ["translation:emit-stream", 2000],
  ["translation:waiting-head", 3000],
  ["boundary:deferred", 2500],
  ["boundary:idle", 3000]
]);

export function createRuntimeLogger(source, prefix) {
  const persistTimestamps = new Map();
  const pendingEntries = [];
  let flushTimer = null;
  let flushChain = Promise.resolve();

  return function logRuntimeEvent(event, details = {}) {
    const timestamp = Date.now();
    const sanitizedDetails = sanitizeLogValue(details, "", 0);

    console.info(prefix, event, sanitizedDetails);

    if (!shouldPersistEvent(event, timestamp, persistTimestamps)) {
      return;
    }

    pendingEntries.push({
      id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      source,
      event,
      timestamp,
      details: sanitizedDetails
    });

    scheduleFlush(shouldFlushImmediately(event) || pendingEntries.length >= MAX_ARRAY_ITEMS ? 0 : RUNTIME_LOG_FLUSH_DELAY_MS);
  };

  function scheduleFlush(delayMs) {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushPendingEntries();
    }, delayMs);
  }

  async function flushPendingEntries() {
    const batch = pendingEntries.splice(0, pendingEntries.length);
    if (!batch.length) {
      return;
    }

    flushChain = flushChain
      .then(() => appendRuntimeLogs(source, batch))
      .catch(() => undefined)
      .finally(() => {
        if (pendingEntries.length && flushTimer == null) {
          scheduleFlush(RUNTIME_LOG_FLUSH_DELAY_MS);
        }
      });

    await flushChain;
  }
}

function shouldPersistEvent(event, timestamp, persistTimestamps) {
  const minIntervalMs = PERSIST_INTERVAL_BY_EVENT.get(event);
  if (!minIntervalMs) {
    return true;
  }

  const lastPersistedAt = persistTimestamps.get(event) || 0;
  if (timestamp - lastPersistedAt < minIntervalMs) {
    return false;
  }

  persistTimestamps.set(event, timestamp);
  return true;
}

function shouldFlushImmediately(event) {
  return IMMEDIATE_FLUSH_EVENT_RE.test(event);
}

function sanitizeLogValue(value, key, depth) {
  if (depth >= MAX_DEPTH) {
    return "[Truncated]";
  }

  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeLogString(value, key);
  }

  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: sanitizeLogString(value.message || String(value), key)
    };
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeLogValue(entry, key, depth + 1));
  }

  if (typeof value === "object") {
    const result = {};

    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_KEYS)) {
      result[childKey] = SECRET_FIELD_RE.test(childKey)
        ? "[REDACTED]"
        : sanitizeLogValue(childValue, childKey, depth + 1);
    }

    return result;
  }

  return sanitizeLogString(String(value), key);
}

function sanitizeLogString(value, key) {
  if (SECRET_FIELD_RE.test(key)) {
    return "[REDACTED]";
  }

  let nextValue = value
    .replace(SECRET_VALUE_RE, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT_RE, "$1[REDACTED]");

  if (/url$/i.test(key)) {
    nextValue = stripUrlSearchAndHash(nextValue);
  }

  if (nextValue.length > MAX_STRING_LENGTH) {
    nextValue = `${nextValue.slice(0, MAX_STRING_LENGTH - 3)}...`;
  }

  return nextValue;
}

function stripUrlSearchAndHash(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/u)[0];
  }
}
