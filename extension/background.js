// Service worker: owns the capture session. It grabs the tab's audio stream id,
// hands it to the offscreen document (where the models run), and relays
// caption lines from there to the tab's overlay and the transcript panel.
//
// Session state lives in chrome.storage.session so the popup and side panel can
// render it, and so it survives the worker being suspended.

import { DEFAULT_SETTINGS } from './shared/languages.js';

const OFFSCREEN_URL = 'offscreen.html';

async function getSession() {
  return (await chrome.storage.session.get('session')).session ?? null;
}

async function patchSession(patch) {
  const session = await getSession();
  if (session) await chrome.storage.session.set({ session: { ...session, ...patch } });
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
}

// --- offscreen document -----------------------------------------------------

let offscreenReady = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  const ready = new Promise((resolve) => (offscreenReady = resolve));
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture tab audio, keep it audible, and transcribe it on-device.',
  });
  await Promise.race([ready, new Promise((r) => setTimeout(r, 5000))]);
}

async function toOffscreen(message) {
  if (!(await chrome.offscreen.hasDocument())) return null;
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message }).catch(() => null);
}

// --- start / stop -------------------------------------------------------------

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  } catch {
    // Tab was open before the extension was installed or reloaded.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  }
}

async function start(tabId) {
  if (await getSession()) await stop();

  await ensureContentScript(tabId);
  await chrome.storage.session.set({
    session: { tabId, status: 'starting', detail: 'Starting…', progress: null, startedAt: Date.now() },
    transcript: [],
  });
  await ensureOffscreen();
  // Stream ids expire within seconds, so get one only once its consumer is ready.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const result = await toOffscreen({ type: 'start', streamId, settings: await getSettings() });
  if (!result?.ok) {
    await stop();
    throw new Error(result?.error ?? 'Could not start audio capture.');
  }
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
  await chrome.action.setBadgeText({ tabId, text: 'CC' });
}

async function stop() {
  const session = await getSession();
  if (await chrome.offscreen.hasDocument()) {
    await toOffscreen({ type: 'stop' });
    // Closing the document releases the capture and all model memory.
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await chrome.storage.session.set({ session: null });
  if (session?.tabId != null) {
    chrome.action.setBadgeText({ tabId: session.tabId, text: '' }).catch(() => {});
    chrome.tabs.sendMessage(session.tabId, { type: 'captions-stopped' }).catch(() => {});
  }
}

async function toggle(tabId) {
  const session = await getSession();
  if (session?.tabId === tabId) return stop();
  return start(tabId).catch((err) => console.error('[live-captions] start failed:', err));
}

// --- transcript ---------------------------------------------------------------

// Writes are serialized so concurrent caption messages can't drop lines.
let transcriptWrite = Promise.resolve();

function saveLine(line) {
  transcriptWrite = transcriptWrite.then(async () => {
    const { transcript = [] } = await chrome.storage.session.get('transcript');
    const i = transcript.findIndex((l) => l.id === line.id);
    const entry = { id: line.id, start: line.start, text: line.text, translation: line.translation ?? '', lang: line.lang };
    if (i >= 0) transcript[i] = entry;
    else transcript.push(entry);
    await chrome.storage.session.set({ transcript });
  }).catch((err) => console.error('[live-captions] transcript write failed:', err));
}

async function toTab(message) {
  const session = await getSession();
  if (session?.tabId != null) chrome.tabs.sendMessage(session.tabId, message).catch(() => {});
}

// --- events -------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  switch (msg.type) {
    case 'start':
      start(msg.tabId).then(
        () => sendResponse({ ok: true }),
        (err) => {
          console.warn('[live-captions] start failed:', err.message);
          sendResponse({ ok: false, error: err.message });
        },
      );
      return true;
    case 'stop':
      stop().then(() => sendResponse({ ok: true }));
      return true;
    case 'offscreen-ready':
      offscreenReady?.();
      return false;
    case 'status':
      patchSession({ status: msg.status, detail: msg.detail, progress: msg.progress ?? null });
      toTab(msg);
      return false;
    case 'caption':
      toTab(msg);
      if (msg.line.final) saveLine(msg.line);
      return false;
    case 'notice':
    case 'translation-needs-download':
    case 'translation-ready':
      toTab(msg);
      return false;
    case 'translation-downloaded':
      toOffscreen({ type: 'retry-translation' });
      return false;
    case 'capture-ended':
      stop();
      return false;
  }
  return false;
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.settings && (await getSession())) {
    toOffscreen({ type: 'settings', settings: { ...DEFAULT_SETTINGS, ...changes.settings.newValue } });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getSession())?.tabId === tabId) stop();
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-captions' && tab?.id != null) toggle(tab.id);
});
