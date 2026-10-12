// Caption overlay. Injected into every page but inert until the extension
// starts sending captions for this tab.
(() => {
  if (globalThis.__liveCaptionsOverlay) return;
  globalThis.__liveCaptionsOverlay = true;

  const HIDE_AFTER_MS = 6000;
  const FONT_PX = { s: 18, m: 24, l: 32 };
  const MAX_CHARS = 170;

  const CSS = `
    :host {
      all: initial !important;
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      display: block !important;
      pointer-events: none !important;
    }
    [hidden] { display: none !important; }
    .wrap {
      position: absolute;
      left: 50%;
      bottom: 8%;
      transform: translateX(-50%);
      width: max-content;
      max-width: min(92vw, 1000px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      color: #fff;
      font: 500 var(--fs, 24px)/1.3 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-align: center;
    }
    .box, .pill, .action { pointer-events: auto; }
    .box {
      position: relative;
      padding: 10px 18px 12px;
      border-radius: 12px;
      background: rgba(12, 12, 14, 0.84);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(8px);
      cursor: grab;
      user-select: none;
    }
    .box:active { cursor: grabbing; }
    .line + .line { margin-top: 8px; }
    .line.prev { opacity: 0.5; }
    .orig { margin-bottom: 2px; color: rgba(255, 255, 255, 0.74); font-size: 0.66em; font-weight: 400; }
    .main { font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
    .main.pending { color: rgba(255, 255, 255, 0.8); font-weight: 400; }
    .close {
      position: absolute;
      top: -9px;
      right: -9px;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: #2a2a2e;
      color: #fff;
      font: 600 14px/22px system-ui, sans-serif;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .box:hover .close, .close:focus-visible { opacity: 1; }
    .pill, .action {
      padding: 5px 12px;
      border-radius: 999px;
      background: rgba(12, 12, 14, 0.84);
      font-size: 13px;
      font-weight: 500;
    }
    .pill.error { background: rgba(185, 28, 28, 0.94); }
    .action { display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; }
    .action button {
      padding: 4px 12px;
      border: 0;
      border-radius: 999px;
      background: #6d8bff;
      color: #0b1020;
      font: 600 13px/1.4 system-ui, sans-serif;
      cursor: pointer;
    }
  `;

  let settings = { showOriginal: true, fontSize: 'm', target: 'es' };
  let position = null; // { cx, bottom } as fractions of the viewport
  let host = null;
  let el = null;
  let lines = []; // newest last
  let hideTimer = null;
  let pillTimer = null;

  chrome.storage.local.get(['settings', 'overlayPosition']).then((stored) => {
    settings = { ...settings, ...stored.settings };
    position = stored.overlayPosition ?? null;
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
      render();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'ping':
        sendResponse(true);
        break;
      case 'caption':
        onCaption(msg.line);
        break;
      case 'status':
        onStatus(msg);
        break;
      case 'notice':
        showPill(msg.text, '', 5000);
        break;
      case 'translation-needs-download':
        offerDownload(msg);
        break;
      case 'translation-ready':
        if (el) el.action.hidden = true;
        break;
      case 'captions-stopped':
        teardown();
        break;
    }
    return false;
  });

  // --- DOM -------------------------------------------------------------------

  function ensureHost() {
    if (host) return;
    host = document.createElement('live-captions-overlay');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <div class="pill" hidden></div>
        <div class="action" hidden><span></span><button></button></div>
        <div class="box" hidden>
          <button class="close" title="Stop captions" aria-label="Stop captions">×</button>
          <div class="lines" aria-live="polite"></div>
        </div>
      </div>`;
    el = {
      wrap: root.querySelector('.wrap'),
      pill: root.querySelector('.pill'),
      action: root.querySelector('.action'),
      box: root.querySelector('.box'),
      lines: root.querySelector('.lines'),
    };
    // Keep clicks on the overlay from reaching the page (e.g. pausing a video).
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) {
      el.wrap.addEventListener(type, (e) => e.stopPropagation());
    }
    root.querySelector('.close').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop' }));
    enableDragging();
    attach();
    document.addEventListener('fullscreenchange', attach);
  }

  // In fullscreen only the fullscreen element renders, so move the overlay into it.
  function attach() {
    if (!host) return;
    const fs = document.fullscreenElement;
    const parent = fs && !(fs instanceof HTMLVideoElement) && !(fs instanceof HTMLIFrameElement)
      ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function teardown() {
    document.removeEventListener('fullscreenchange', attach);
    host?.remove();
    host = el = null;
    lines = [];
    clearTimeout(hideTimer);
    clearTimeout(pillTimer);
  }

  function enableDragging() {
    el.box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const rect = el.wrap.getBoundingClientRect();
      const [w, h] = [innerWidth, innerHeight];
      const start = { x: e.clientX, y: e.clientY, cx: (rect.left + rect.width / 2) / w, bottom: (h - rect.bottom) / h };
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      const move = (ev) => {
        position = {
          cx: clamp(start.cx + (ev.clientX - start.x) / w, 0.05, 0.95),
          bottom: clamp(start.bottom - (ev.clientY - start.y) / h, 0, 0.9),
        };
        place();
      };
      const up = () => {
        el.box.removeEventListener('pointermove', move);
        el.box.removeEventListener('pointerup', up);
        if (position) chrome.storage.local.set({ overlayPosition: position });
      };
      el.box.setPointerCapture(e.pointerId);
      el.box.addEventListener('pointermove', move);
      el.box.addEventListener('pointerup', up);
    });
    el.box.addEventListener('dblclick', () => {
      position = null;
      place();
      chrome.storage.local.remove('overlayPosition');
    });
  }

  function place() {
    if (!el) return;
    el.wrap.style.left = position ? `${position.cx * 100}%` : '';
    el.wrap.style.bottom = position ? `${position.bottom * 100}%` : '';
  }

  // --- captions ----------------------------------------------------------------

  function onCaption(line) {
    ensureHost();
    const entry = { ...line, at: Date.now() };
    const i = lines.findIndex((l) => l.id === line.id);
    if (i >= 0) lines[i] = entry;
    else lines = [...lines.slice(-3), entry];
    if (el.pill.dataset.kind === 'listening') hidePill();
    if (line.translation) el.action.hidden = true;
    render();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(render, HIDE_AFTER_MS + 50);
  }

  const sameLanguage = (a, b) => !!a && !!b && a.split('-')[0] === b.split('-')[0];

  // Long lines show their most recent words.
  function tail(text) {
    if (text.length <= MAX_CHARS) return text;
    const cut = text.slice(-MAX_CHARS);
    const space = cut.indexOf(' ');
    return '…' + (space > 0 && space < 20 ? cut.slice(space + 1) : cut);
  }

  function lineElement(line, previous) {
    const div = document.createElement('div');
    div.className = previous ? 'line prev' : 'line';
    const translated = !!line.translation;
    if (translated && settings.showOriginal) {
      const orig = document.createElement('div');
      orig.className = 'orig';
      orig.dir = 'auto';
      orig.textContent = tail(line.text);
      div.append(orig);
    }
    const main = document.createElement('div');
    const awaiting = !translated && settings.target !== 'off' && !sameLanguage(line.lang, settings.target);
    main.className = awaiting ? 'main pending' : 'main';
    main.dir = 'auto';
    main.textContent = tail(translated ? line.translation : line.text);
    div.append(main);
    return div;
  }

  function render() {
    if (!el) return;
    place();
    el.wrap.style.setProperty('--fs', `${FONT_PX[settings.fontSize] ?? FONT_PX.m}px`);
    const now = Date.now();
    const recent = (l) => now - l.at < (l.final ? HIDE_AFTER_MS : HIDE_AFTER_MS * 2);
    const shown = lines.slice(-2).filter(recent);
    el.lines.replaceChildren(...shown.map((l, i) => lineElement(l, i < shown.length - 1)));
    el.box.hidden = shown.length === 0;
  }

  // --- status ------------------------------------------------------------------

  function showPill(text, kind = '', ms = 0) {
    ensureHost();
    clearTimeout(pillTimer);
    el.pill.textContent = text;
    el.pill.className = kind === 'error' ? 'pill error' : 'pill';
    el.pill.dataset.kind = kind;
    el.pill.hidden = false;
    if (ms) pillTimer = setTimeout(hidePill, ms);
  }

  function hidePill() {
    if (!el) return;
    el.pill.hidden = true;
    el.pill.dataset.kind = '';
  }

  function onStatus({ status, detail, progress }) {
    if (status === 'loading') {
      const pct = progress == null ? '' : ` ${Math.round(progress * 100)}%`;
      showPill(`${detail}${pct}`, 'loading');
    } else if (status === 'listening') {
      showPill('Listening…', 'listening', 4000);
    } else if (status === 'error') {
      showPill(detail, 'error');
    } else if (status === 'starting') {
      showPill('Starting captions…', 'loading');
    }
  }

  // Language packs download on a user gesture; offer one here when the hidden
  // engine page couldn't start the download itself.
  function offerDownload({ source, target, pair }) {
    ensureHost();
    const [label, button] = el.action.children;
    if (typeof Translator === 'undefined') {
      label.textContent = `${pair} translation isn't downloaded yet. Press Start in the extension popup to get it.`;
      button.hidden = true;
      el.action.hidden = false;
      return;
    }
    label.textContent = `${pair} translation needs a one-time download.`;
    button.hidden = false;
    button.disabled = false;
    button.textContent = 'Download';
    button.onclick = async () => {
      button.disabled = true;
      try {
        const translator = await Translator.create({
          sourceLanguage: source,
          targetLanguage: target,
          monitor: (m) => m.addEventListener('downloadprogress', (e) => {
            button.textContent = `${Math.round(e.loaded * 100)}%`;
          }),
        });
        translator.destroy();
        el.action.hidden = true;
        chrome.runtime.sendMessage({ type: 'translation-downloaded' });
      } catch (err) {
        label.textContent = `Couldn't download ${pair}: ${err.message}`;
        button.hidden = true;
      }
    };
    el.action.hidden = false;
  }
})();
