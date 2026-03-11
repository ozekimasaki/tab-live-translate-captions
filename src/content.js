import { DEFAULT_SETTINGS, DISPLAY_MODES, MESSAGE_TYPES, SESSION_STATUS } from "./constants.js";
import { getLanguagePairLabel, getOverlayPlaceholder, getOverlayStatusLabel } from "./ui-copy.js";

const preservedOverlayState = window.__deepframOverlayController?.exportState?.() || null;

if (window.__deepframOverlayController?.destroy) {
  window.__deepframOverlayController.destroy();
}

window.__deepframContentLoaded = true;
window.__deepframOverlayController = createDeepframOverlay(preservedOverlayState);

function createDeepframOverlay(initialState = null) {
  const overlay = document.createElement("div");
  overlay.id = "deepfram-overlay";
  overlay.dataset.displayMode = DISPLAY_MODES.translationOnly;
  overlay.dataset.previewVisible = "false";
  overlay.dataset.hasPreview = "false";
  overlay.dataset.hasSource = "false";
  overlay.dataset.hasError = "false";
  overlay.dataset.state = SESSION_STATUS.idle;
  overlay.innerHTML = `
    <div class="deepfram-shell">
      <div class="deepfram-drag" title="字幕バーを移動"></div>
      <div class="deepfram-head">
        <div class="deepfram-chip">
          <span class="deepfram-chip-dot"></span>
          <span class="deepfram-status">待機中</span>
        </div>
        <span class="deepfram-pair">英語 → 日本語</span>
      </div>
      <section class="deepfram-block deepfram-block-preview">
        <span class="deepfram-label">原文プレビュー</span>
        <p class="deepfram-preview"></p>
      </section>
      <section class="deepfram-block deepfram-block-source">
        <span class="deepfram-label">原文</span>
        <p class="deepfram-source"></p>
      </section>
      <section class="deepfram-block deepfram-block-translation">
        <span class="deepfram-label">翻訳字幕</span>
        <p class="deepfram-translation"></p>
      </section>
      <p class="deepfram-error"></p>
    </div>
  `;

  const state = createInitialState(initialState);
  const elements = getElements(overlay);
  const requestRender = () => render();
  const onMessage = (message, sender, sendResponse) => {
    if (!message?.type) {
      return undefined;
    }

    if (message.type === MESSAGE_TYPES.contentPing) {
      sendResponse({ ok: true });
      return undefined;
    }

    applyMessageToState(state, message, requestRender);
    if (message.type === MESSAGE_TYPES.clearOverlay) {
      syncOverlayHost(overlay);
    }
    render();
    return undefined;
  };
  const onResize = () => render();
  const onFullscreenChange = () => {
    syncOverlayHost(overlay);
    render();
  };

  document.body.appendChild(overlay);
  syncOverlayHost(overlay);
  bindDragging({ overlay, elements, state });
  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener("resize", onResize);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  render();

  function render() {
    const hasContent = Boolean(state.sourceText || state.previewText || state.translationText || state.errorText);
    const isVisible = state.sessionStatus !== SESSION_STATUS.idle || hasContent;
    const position = clampOffset(overlay, state.settings.overlayOffset || DEFAULT_SETTINGS.overlayOffset);
    const placeholder = state.translationText || (isVisible ? getOverlayPlaceholder(state.sessionStatus) : "");

    syncOverlayHost(overlay);

    state.settings.overlayOffset = position;
    overlay.classList.toggle("deepfram-visible", isVisible);
    overlay.dataset.displayMode = state.settings.displayMode || DISPLAY_MODES.translationOnly;
    overlay.dataset.previewVisible = String(Boolean(state.settings.showSourcePreview));
    overlay.dataset.hasPreview = String(Boolean(state.previewText));
    overlay.dataset.hasSource = String(Boolean(state.sourceText));
    overlay.dataset.hasError = String(Boolean(state.errorText));
    overlay.dataset.state = state.sessionStatus;
    overlay.style.left = `calc(50% + ${position.x}px)`;
    overlay.style.bottom = `${28 + position.y}px`;

    elements.shell.style.background = `rgba(12, 16, 18, ${Number(
      state.settings.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity
    ).toFixed(2)})`;
    elements.status.textContent = getOverlayStatusLabel(state.sessionStatus, state.statusText);
    elements.pair.textContent = getLanguagePairLabel(state.settings.sourceLang, state.settings.targetLang);
    elements.preview.textContent = state.previewText;
    elements.source.textContent = state.sourceText;
    elements.translation.textContent = placeholder;
    elements.error.textContent = state.errorText;
  }

  return {
    exportState() {
      return snapshotState(state);
    },
    destroy() {
      resetPendingTranslationState(state);
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      overlay.remove();
    }
  };
}

function bindDragging({ overlay, elements, state }) {
  let dragState = null;

  elements.dragHandle.addEventListener("pointerdown", (event) => {
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...state.settings.overlayOffset }
    };

    elements.dragHandle.setPointerCapture(event.pointerId);
    elements.dragHandle.style.cursor = "grabbing";
  });

  elements.dragHandle.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    state.settings.overlayOffset = clampOffset(overlay, {
      x: dragState.origin.x + (event.clientX - dragState.startX),
      y: dragState.origin.y + (dragState.startY - event.clientY)
    });
    syncOverlayHost(overlay);
    overlay.style.left = `calc(50% + ${state.settings.overlayOffset.x}px)`;
    overlay.style.bottom = `${28 + state.settings.overlayOffset.y}px`;
  });

  const finishDrag = async (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    dragState = null;
    elements.dragHandle.style.cursor = "grab";

    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.overlayUpdated,
        overlayOffset: state.settings.overlayOffset
      });
    } catch {
      // background may be sleeping momentarily
    }
  };

  elements.dragHandle.addEventListener("pointerup", finishDrag);
  elements.dragHandle.addEventListener("pointercancel", finishDrag);
}

function applyMessageToState(state, message, onStateChanged = null) {
  switch (message.type) {
    case MESSAGE_TYPES.settingsUpdated:
      state.settings = {
        ...state.settings,
        ...message.settings
      };
      return;
    case MESSAGE_TYPES.sessionStatusChanged:
      state.sessionStatus = message.status;
      state.statusText = message.message || state.statusText;
      if ([SESSION_STATUS.idle, SESSION_STATUS.error, SESSION_STATUS.stopping].includes(message.status)) {
        resetPendingTranslationState(state);
      }
      if (message.status !== SESSION_STATUS.error) {
        state.errorText = "";
      }
      return;
    case MESSAGE_TYPES.partialTranscript:
      state.sessionStatus = SESSION_STATUS.active;
      state.statusText = "音声認識中";
      state.previewText = message.transcript || "";
      state.errorText = "";
      return;
    case MESSAGE_TYPES.finalTranscript:
      state.sessionStatus = SESSION_STATUS.active;
      state.statusText = "翻訳待ち";
      state.previewText = "";
      state.errorText = "";
      if (!state.translationText) {
        state.sourceText = message.transcript || "";
      }
      return;
    case MESSAGE_TYPES.finalTranslation:
      handleIncomingTranslation(state, message, onStateChanged);
      return;
    case MESSAGE_TYPES.sessionError:
      resetPendingTranslationState(state);
      state.sessionStatus = SESSION_STATUS.error;
      state.statusText = "要確認";
      state.errorText = message.error || "処理中にエラーが発生しました。";
      return;
    case MESSAGE_TYPES.clearOverlay:
      clearState(state);
      return;
    default:
      return;
  }
}

function clearState(state) {
  resetPendingTranslationState(state);
  state.sessionStatus = SESSION_STATUS.idle;
  state.sourceText = "";
  state.previewText = "";
  state.translationText = "";
  state.translationSequenceId = 0;
  state.errorText = "";
  state.statusText = "待機中";
}

function createInitialState(snapshot = null) {
  const translationSequenceId = Number(snapshot?.translationSequenceId || 0);
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...(snapshot?.settings || {})
    },
    sessionStatus: snapshot?.sessionStatus || SESSION_STATUS.idle,
    sourceText: snapshot?.sourceText || "",
    previewText: snapshot?.previewText || "",
    translationText: snapshot?.translationText || "",
    translationSequenceId,
    errorText: snapshot?.errorText || "",
    statusText: snapshot?.statusText || "待機中",
    displayedIsFinal: Boolean(snapshot?.translationText) && snapshot?.statusText === "字幕表示中",
    displayHoldUntil: 0,
    queuedTranslations: new Map(),
    switchTimerId: null
  };
}

function snapshotState(state) {
  return {
    settings: {
      ...state.settings,
      overlayOffset: {
        x: Number(state.settings?.overlayOffset?.x || 0),
        y: Number(state.settings?.overlayOffset?.y || 0)
      }
    },
    sessionStatus: state.sessionStatus,
    sourceText: state.sourceText,
    previewText: state.previewText,
    translationText: state.translationText,
    translationSequenceId: state.translationSequenceId,
    errorText: state.errorText,
    statusText: state.statusText
  };
}

function getElements(overlay) {
  return {
    dragHandle: overlay.querySelector(".deepfram-drag"),
    shell: overlay.querySelector(".deepfram-shell"),
    status: overlay.querySelector(".deepfram-status"),
    pair: overlay.querySelector(".deepfram-pair"),
    preview: overlay.querySelector(".deepfram-preview"),
    source: overlay.querySelector(".deepfram-source"),
    translation: overlay.querySelector(".deepfram-translation"),
    error: overlay.querySelector(".deepfram-error")
  };
}

function syncOverlayHost(overlay) {
  const host = document.fullscreenElement || document.body || document.documentElement;
  if (host && overlay.parentElement !== host) {
    host.appendChild(overlay);
  }
}

function clampOffset(overlay, offset) {
  const rect = overlay.getBoundingClientRect();
  const maxX = Math.max(0, window.innerWidth / 2 - rect.width / 2 - 8);
  const minY = -20;
  const maxY = Math.max(minY, window.innerHeight - rect.height - 36);

  return {
    x: Math.max(-maxX, Math.min(maxX, Number(offset?.x || 0))),
    y: Math.max(minY, Math.min(maxY, Number(offset?.y || 0)))
  };
}

function handleIncomingTranslation(state, message, onStateChanged) {
  const sequenceId = Number(message.sequenceId || 0);
  if (!Number.isFinite(sequenceId) || sequenceId <= 0) {
    return;
  }

  if (sequenceId < state.translationSequenceId) {
    return;
  }

  const payload = {
    sequenceId,
    isFinal: Boolean(message.isFinal),
    sourceText: message.sourceText || "",
    translation: message.translation || ""
  };

  if (sequenceId === state.translationSequenceId) {
    if (state.displayedIsFinal && !payload.isFinal) {
      return;
    }
    applyDisplayedTranslation(state, payload);
    reconcileQueuedTranslations(state, onStateChanged);
    return;
  }

  queuePendingTranslation(state, payload);
  reconcileQueuedTranslations(state, onStateChanged);
}

function queuePendingTranslation(state, payload) {
  const existing = state.queuedTranslations.get(payload.sequenceId);
  if (existing?.isFinal && !payload.isFinal) {
    return;
  }

  state.queuedTranslations.set(payload.sequenceId, {
    sequenceId: payload.sequenceId,
    isFinal: Boolean(existing?.isFinal || payload.isFinal),
    sourceText: payload.sourceText || existing?.sourceText || "",
    translation: payload.translation || existing?.translation || ""
  });
}

function applyDisplayedTranslation(state, payload) {
  state.sessionStatus = SESSION_STATUS.active;
  state.translationSequenceId = payload.sequenceId;
  state.displayedIsFinal = Boolean(payload.isFinal);
  state.statusText = payload.isFinal ? "字幕表示中" : "翻訳を生成中";
  state.sourceText = payload.sourceText || state.sourceText;
  state.translationText = payload.translation || "";
  state.errorText = "";
  state.displayHoldUntil = payload.isFinal ? Date.now() + calculateTranslationHoldMs(state.translationText) : 0;
}

function reconcileQueuedTranslations(state, onStateChanged) {
  if (!state.queuedTranslations.size) {
    clearTranslationSwitchTimer(state);
    return;
  }

  if (shouldHoldDisplayedTranslation(state)) {
    scheduleTranslationSwitch(state, onStateChanged);
    return;
  }

  clearTranslationSwitchTimer(state);

  const nextPayload = getNextQueuedTranslation(state);
  if (!nextPayload) {
    return;
  }

  state.queuedTranslations.delete(nextPayload.sequenceId);
  applyDisplayedTranslation(state, nextPayload);

  if (shouldHoldDisplayedTranslation(state)) {
    scheduleTranslationSwitch(state, onStateChanged);
    return;
  }

  reconcileQueuedTranslations(state, onStateChanged);
}

function getNextQueuedTranslation(state) {
  let nextPayload = null;

  for (const payload of state.queuedTranslations.values()) {
    if (!nextPayload || payload.sequenceId < nextPayload.sequenceId) {
      nextPayload = payload;
    }
  }

  return nextPayload;
}

function shouldHoldDisplayedTranslation(state) {
  return Boolean(state.translationSequenceId && state.displayedIsFinal && Date.now() < state.displayHoldUntil);
}

function scheduleTranslationSwitch(state, onStateChanged) {
  const delayMs = Math.max(0, state.displayHoldUntil - Date.now());
  clearTranslationSwitchTimer(state);

  if (delayMs === 0) {
    reconcileQueuedTranslations(state, onStateChanged);
    return;
  }

  state.switchTimerId = setTimeout(() => {
    state.switchTimerId = null;
    reconcileQueuedTranslations(state, onStateChanged);
    onStateChanged?.();
  }, delayMs);
}

function clearTranslationSwitchTimer(state) {
  if (!state.switchTimerId) {
    return;
  }

  clearTimeout(state.switchTimerId);
  state.switchTimerId = null;
}

function resetPendingTranslationState(state) {
  clearTranslationSwitchTimer(state);
  state.displayedIsFinal = false;
  state.displayHoldUntil = 0;
  state.queuedTranslations.clear();
}

function calculateTranslationHoldMs(translationText) {
  const length = String(translationText || "").trim().length;
  return Math.min(2400, Math.max(900, 480 + length * 55));
}
