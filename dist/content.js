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

  // src/ui-copy.js
  var LANGUAGE_LABELS = {
    en: "\u82F1\u8A9E",
    ja: "\u65E5\u672C\u8A9E",
    zh: "\u4E2D\u56FD\u8A9E"
  };
  var DISPLAY_MODE_OPTIONS = [
    {
      value: DISPLAY_MODES.translationOnly,
      label: "\u7FFB\u8A33\u306E\u307F",
      description: "\u7FFB\u8A33\u5B57\u5E55\u3060\u3051\u3092\u5927\u304D\u304F\u8868\u793A"
    },
    {
      value: DISPLAY_MODES.dual,
      label: "\u539F\u6587 + \u7FFB\u8A33",
      description: "\u539F\u6587\u3092\u88DC\u52A9\u8868\u793A\u3057\u3066\u78BA\u8A8D\u3057\u3084\u3059\u304F\u3059\u308B"
    }
  ];
  var SEGMENTATION_MODE_OPTIONS = [
    {
      value: SEGMENTATION_MODES.latency,
      label: "\u4F4E\u9045\u5EF6",
      description: "\u5B57\u5E55\u3092\u901F\u3081\u306B\u51FA\u3059"
    },
    {
      value: SEGMENTATION_MODES.balanced,
      label: "\u6A19\u6E96",
      description: "\u901F\u3055\u3068\u8AAD\u307F\u3084\u3059\u3055\u306E\u30D0\u30E9\u30F3\u30B9"
    },
    {
      value: SEGMENTATION_MODES.natural,
      label: "\u81EA\u7136",
      description: "\u307E\u3068\u307E\u308A\u3092\u512A\u5148\u3057\u3066\u8868\u793A"
    }
  ];
  function getLanguageLabel(language) {
    return LANGUAGE_LABELS[language] || String(language || "").toUpperCase();
  }
  function getLanguagePairLabel(sourceLang, targetLang) {
    return `${getLanguageLabel(sourceLang)} \u2192 ${getLanguageLabel(targetLang)}`;
  }
  function getOverlayStatusLabel(sessionStatus, statusText) {
    if (statusText && sessionStatus !== SESSION_STATUS.idle) {
      return statusText;
    }
    switch (sessionStatus) {
      case SESSION_STATUS.starting:
        return "\u63A5\u7D9A\u4E2D";
      case SESSION_STATUS.active:
        return "\u5B57\u5E55\u8868\u793A\u4E2D";
      case SESSION_STATUS.error:
        return "\u8981\u78BA\u8A8D";
      default:
        return "\u5F85\u6A5F\u4E2D";
    }
  }
  function getOverlayPlaceholder(sessionStatus) {
    if (sessionStatus === SESSION_STATUS.active || sessionStatus === SESSION_STATUS.starting) {
      return "\u7FFB\u8A33\u5B57\u5E55\u3092\u751F\u6210\u3057\u3066\u3044\u307E\u3059\u2026";
    }
    return "\u97F3\u58F0\u3092\u5F85\u6A5F\u3057\u3066\u3044\u307E\u3059\u2026";
  }

  // src/content.js
  if (window.__deepframOverlayController?.destroy) {
    window.__deepframOverlayController.destroy();
  }
  window.__deepframContentLoaded = true;
  window.__deepframOverlayController = createDeepframOverlay();
  function createDeepframOverlay() {
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
      <div class="deepfram-drag" title="\u5B57\u5E55\u30D0\u30FC\u3092\u79FB\u52D5"></div>
      <div class="deepfram-head">
        <div class="deepfram-chip">
          <span class="deepfram-chip-dot"></span>
          <span class="deepfram-status">\u5F85\u6A5F\u4E2D</span>
        </div>
        <span class="deepfram-pair">\u82F1\u8A9E \u2192 \u65E5\u672C\u8A9E</span>
      </div>
      <section class="deepfram-block deepfram-block-preview">
        <span class="deepfram-label">\u539F\u6587\u30D7\u30EC\u30D3\u30E5\u30FC</span>
        <p class="deepfram-preview"></p>
      </section>
      <section class="deepfram-block deepfram-block-source">
        <span class="deepfram-label">\u539F\u6587</span>
        <p class="deepfram-source"></p>
      </section>
      <section class="deepfram-block deepfram-block-translation">
        <span class="deepfram-label">\u7FFB\u8A33\u5B57\u5E55</span>
        <p class="deepfram-translation"></p>
      </section>
      <p class="deepfram-error"></p>
    </div>
  `;
    const state = createInitialState();
    const elements = getElements(overlay);
    const onMessage = (message) => {
      if (!message?.type) {
        return void 0;
      }
      applyMessageToState(state, message);
      if (message.type === MESSAGE_TYPES.clearOverlay) {
        syncOverlayHost(overlay);
      }
      render();
      return void 0;
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
        state.statusText = "\u97F3\u58F0\u8A8D\u8B58\u4E2D";
        state.previewText = message.transcript || "";
        state.errorText = "";
        return;
      case MESSAGE_TYPES.finalTranscript:
        state.sessionStatus = SESSION_STATUS.active;
        state.statusText = "\u7FFB\u8A33\u4E2D";
        state.sourceText = message.transcript || "";
        state.translationSequenceId = Math.max(state.translationSequenceId, Number(message.sequenceId || 0));
        state.previewText = "";
        state.errorText = "";
        return;
      case MESSAGE_TYPES.finalTranslation:
        if (Number(message.sequenceId || 0) < state.translationSequenceId) {
          return;
        }
        state.sessionStatus = SESSION_STATUS.active;
        state.translationSequenceId = Number(message.sequenceId || 0);
        state.statusText = message.isFinal ? "\u5B57\u5E55\u8868\u793A\u4E2D" : "\u7FFB\u8A33\u3092\u751F\u6210\u4E2D";
        state.translationText = message.translation || "";
        state.errorText = "";
        return;
      case MESSAGE_TYPES.sessionError:
        state.sessionStatus = SESSION_STATUS.error;
        state.statusText = "\u8981\u78BA\u8A8D";
        state.errorText = message.error || "\u51E6\u7406\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F\u3002";
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
    state.statusText = "\u5F85\u6A5F\u4E2D";
  }
  function createInitialState() {
    return {
      settings: { ...DEFAULT_SETTINGS },
      sessionStatus: SESSION_STATUS.idle,
      sourceText: "",
      previewText: "",
      translationText: "",
      translationSequenceId: 0,
      errorText: "",
      statusText: "\u5F85\u6A5F\u4E2D"
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
})();
