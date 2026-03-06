(() => {
  // src/constants.js
  var DISPLAY_MODES = {
    translationOnly: "translation-only",
    dual: "dual"
  };
  var SEGMENTATION_MODES = {
    latency: "latency",
    balanced: "balanced",
    natural: "natural"
  };
  var DEFAULT_SETTINGS = {
    deepgramApiKey: "",
    geminiApiKey: "",
    sourceLang: "en",
    targetLang: "ja",
    displayMode: DISPLAY_MODES.translationOnly,
    segmentationMode: SEGMENTATION_MODES.balanced,
    showSourcePreview: false,
    overlayOpacity: 0.78,
    overlayAnchor: "bottom-center",
    overlayOffset: {
      x: 0,
      y: 0
    }
  };
  var SESSION_STATUS = {
    idle: "idle",
    starting: "starting",
    active: "active",
    stopping: "stopping",
    error: "error"
  };
  var MESSAGE_TYPES = {
    getState: "GET_STATE",
    startSession: "START_SESSION",
    stopSession: "STOP_SESSION",
    settingsUpdated: "SETTINGS_UPDATED",
    sessionStatusChanged: "SESSION_STATUS_CHANGED",
    partialTranscript: "PARTIAL_TRANSCRIPT",
    finalTranscript: "FINAL_TRANSCRIPT",
    finalTranslation: "FINAL_TRANSLATION",
    sessionError: "SESSION_ERROR",
    overlayUpdated: "OVERLAY_UPDATED",
    clearOverlay: "CLEAR_OVERLAY"
  };

  // src/content.js
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
        <span class="deepfram-pair">EN \u2192 JA</span>
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
      statusText: "\u505C\u6B62\u4E2D"
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
        return void 0;
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
          state.statusText = "\u97F3\u58F0\u8A8D\u8B58\u4E2D";
          state.previewText = message.transcript || "";
          state.errorText = "";
          break;
        case MESSAGE_TYPES.finalTranscript:
          state.sessionStatus = SESSION_STATUS.active;
          state.statusText = "\u7FFB\u8A33\u4E2D";
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
          state.statusText = message.isFinal ? "\u5B57\u5E55\u8868\u793A\u4E2D" : "\u7FFB\u8A33\u30B9\u30C8\u30EA\u30FC\u30DF\u30F3\u30B0\u4E2D";
          state.translationText = message.translation || "";
          state.errorText = "";
          break;
        case MESSAGE_TYPES.sessionError:
          state.sessionStatus = SESSION_STATUS.error;
          state.statusText = "\u30A8\u30E9\u30FC";
          state.errorText = message.error || "\u51E6\u7406\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002";
          break;
        case MESSAGE_TYPES.clearOverlay:
          clearState();
          break;
        default:
          return void 0;
      }
      render();
      return void 0;
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
      state.statusText = "\u505C\u6B62\u4E2D";
    }
    function render() {
      syncOverlayHost();
      const showOverlay = state.sessionStatus !== SESSION_STATUS.idle || Boolean(state.sourceText || state.translationText || state.previewText || state.errorText);
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
      elements.pair.textContent = `${state.settings.sourceLang.toUpperCase()} \u2192 ${state.settings.targetLang.toUpperCase()}`;
      elements.preview.textContent = state.previewText;
      elements.source.textContent = state.sourceText;
      elements.translation.textContent = state.translationText || (showOverlay ? "\u97F3\u58F0\u3092\u5F85\u6A5F\u3057\u3066\u3044\u307E\u3059\u2026" : "");
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
})();
