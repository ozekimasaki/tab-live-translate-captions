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
  const onMessage = (message, sender, sendResponse) => {
    if (!message?.type) {
      return undefined;
    }

    if (message.type === MESSAGE_TYPES.contentPing) {
      sendResponse({ ok: true });
      return undefined;
    }

    applyMessageToState(state, message);
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

function applyMessageToState(state, message) {
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
      if (Number(message.sequenceId || 0) < state.translationSequenceId) {
        return;
      }

      state.sessionStatus = SESSION_STATUS.active;
      state.translationSequenceId = Number(message.sequenceId || 0);
      state.statusText = message.isFinal ? "字幕表示中" : "翻訳を生成中";
      state.sourceText = message.sourceText || state.sourceText;
      state.translationText = message.translation || "";
      state.errorText = "";
      return;
    case MESSAGE_TYPES.sessionError:
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
  state.sessionStatus = SESSION_STATUS.idle;
  state.sourceText = "";
  state.previewText = "";
  state.translationText = "";
  state.translationSequenceId = 0;
  state.errorText = "";
  state.statusText = "待機中";
}

function createInitialState(snapshot = null) {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...(snapshot?.settings || {})
    },
    sessionStatus: snapshot?.sessionStatus || SESSION_STATUS.idle,
    sourceText: snapshot?.sourceText || "",
    previewText: snapshot?.previewText || "",
    translationText: snapshot?.translationText || "",
    translationSequenceId: Number(snapshot?.translationSequenceId || 0),
    errorText: snapshot?.errorText || "",
    statusText: snapshot?.statusText || "待機中"
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
