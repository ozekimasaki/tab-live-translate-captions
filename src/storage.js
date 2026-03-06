import { DEFAULT_SETTINGS, SESSION_STATUS, STORAGE_KEYS } from "./constants.js";

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
