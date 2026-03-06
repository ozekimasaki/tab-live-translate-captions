import { DEFAULT_SETTINGS, DISPLAY_MODES, MESSAGE_TYPES, SESSION_STATUS } from "./constants.js";

if (!window.__deepframContentLoaded) {
  window.__deepframContentLoaded = true;
  createDeepframOverlay();
}

function createDeepframOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "deepfram-overlay";
  overlay.dataset.displayMode = DISPLAY_MODES.translationOnly;
  overlay.dataset.previewVisible = "false";
  overlay.innerHTML = `
    <div class="deepfram-shell">
      <div class="deepfram-drag" title="Drag subtitle overlay"></div>
      <div class="deepfram-meta">
        <span class="deepfram-status">Stopped</span>
        <span class="deepfram-pair">EN → JA</span>
      </div>
      <p class="deepfram-preview"></p>
      <p class="deepfram-source"></p>
      <p class="deepfram-translation"></p>
      <p class="deepfram-error"></p>
    </div>
  `;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    sessionStatus: SESSION_STATUS.idle,
    sourceText: "",
    previewText: "",
    translationText: "",
    translationSequenceId: 0,
    errorText: "",
    statusText: "停止中"
  };

  const elements = {
    dragHandle: overlay.querySelector(".deepfram-drag"),
    status: overlay.querySelector(".deepfram-status"),
    pair: overlay.querySelector(".deepfram-pair"),
    preview: overlay.querySelector(".deepfram-preview"),
    source: overlay.querySelector(".deepfram-source"),
    translation: overlay.querySelector(".deepfram-translation"),
    error: overlay.querySelector(".deepfram-error"),
    shell: overlay.querySelector(".deepfram-shell")
  };

  document.body.appendChild(overlay);
  syncOverlayHost();
  render();
  bindDragging();

  chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) {
      return undefined;
    }

    switch (message.type) {
      case MESSAGE_TYPES.settingsUpdated:
        state.settings = {
          ...state.settings,
          ...message.settings
        };
        break;
      case MESSAGE_TYPES.sessionStatusChanged:
        state.sessionStatus = message.status;
        state.statusText = message.message || state.statusText;
        break;
      case MESSAGE_TYPES.partialTranscript:
        state.sessionStatus = SESSION_STATUS.active;
        state.statusText = "音声認識中";
        state.previewText = message.transcript || "";
        state.errorText = "";
        break;
      case MESSAGE_TYPES.finalTranscript:
        state.sessionStatus = SESSION_STATUS.active;
        state.statusText = "翻訳中";
        state.sourceText = message.transcript || "";
        state.translationSequenceId = Math.max(state.translationSequenceId, Number(message.sequenceId || 0));
        state.previewText = "";
        state.errorText = "";
        break;
      case MESSAGE_TYPES.finalTranslation:
        if (Number(message.sequenceId || 0) < state.translationSequenceId) {
          break;
        }

        state.sessionStatus = SESSION_STATUS.active;
        state.translationSequenceId = Number(message.sequenceId || 0);
        state.statusText = message.isFinal ? "字幕表示中" : "翻訳ストリーミング中";
        state.translationText = message.translation || "";
        state.errorText = "";
        break;
      case MESSAGE_TYPES.sessionError:
        state.sessionStatus = SESSION_STATUS.error;
        state.statusText = "エラー";
        state.errorText = message.error || "処理中にエラーが発生しました。";
        break;
      case MESSAGE_TYPES.clearOverlay:
        clearState();
        break;
      default:
        return undefined;
    }

    render();
    return undefined;
  });

  window.addEventListener("resize", render);
  document.addEventListener("fullscreenchange", () => {
    syncOverlayHost();
    render();
  });

  function clearState() {
    state.sessionStatus = SESSION_STATUS.idle;
    state.sourceText = "";
    state.previewText = "";
    state.translationText = "";
    state.translationSequenceId = 0;
    state.errorText = "";
    state.statusText = "停止中";
  }

  function render() {
    syncOverlayHost();

    const showOverlay =
      state.sessionStatus !== SESSION_STATUS.idle ||
      Boolean(state.sourceText || state.translationText || state.previewText || state.errorText);

    overlay.classList.toggle("deepfram-visible", showOverlay);
    overlay.dataset.displayMode = state.settings.displayMode || DISPLAY_MODES.translationOnly;
    overlay.dataset.previewVisible = String(Boolean(state.settings.showSourcePreview));

    const opacity = Number(state.settings.overlayOpacity ?? DEFAULT_SETTINGS.overlayOpacity);
    const position = clampOffset(state.settings.overlayOffset || DEFAULT_SETTINGS.overlayOffset);
    state.settings.overlayOffset = position;

    overlay.style.left = `calc(50% + ${position.x}px)`;
    overlay.style.bottom = `${28 + position.y}px`;

    elements.shell.style.background = `rgba(9, 13, 16, ${opacity.toFixed(2)})`;
    elements.status.textContent = state.statusText;
    elements.pair.textContent = `${state.settings.sourceLang.toUpperCase()} → ${state.settings.targetLang.toUpperCase()}`;
    elements.preview.textContent = state.previewText;
    elements.source.textContent = state.sourceText;
    elements.translation.textContent = state.translationText || (showOverlay ? "音声を待機しています…" : "");
    elements.error.textContent = state.errorText;
  }

  function bindDragging() {
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

      const deltaX = event.clientX - dragState.startX;
      const deltaY = dragState.startY - event.clientY;

      state.settings.overlayOffset = clampOffset({
        x: dragState.origin.x + deltaX,
        y: dragState.origin.y + deltaY
      });

      render();
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

  function syncOverlayHost() {
    const host = document.fullscreenElement || document.body || document.documentElement;
    if (host && overlay.parentElement !== host) {
      host.appendChild(overlay);
    }
  }

  function clampOffset(offset) {
    const rect = overlay.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth / 2 - rect.width / 2 - 8);
    const minY = -20;
    const maxY = Math.max(minY, window.innerHeight - rect.height - 36);

    return {
      x: Math.max(-maxX, Math.min(maxX, Number(offset.x || 0))),
      y: Math.max(minY, Math.min(maxY, Number(offset.y || 0)))
    };
  }
}
