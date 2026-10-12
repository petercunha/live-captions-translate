import { DEFAULT_SETTINGS, EN_MODELS, SPOKEN, TARGETS, languageName, sameLanguage } from './shared/languages.js';

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
let session = (await chrome.storage.session.get('session')).session ?? null;

function fillSelects() {
  const groups = [
    ['Streaming models (lightest)', SPOKEN.filter((l) => l.engine === 'moonshine')],
    ['Whisper (any language, uses the GPU)', SPOKEN.filter((l) => l.engine === 'whisper')],
  ];
  for (const [label, languages] of groups) {
    const group = document.createElement('optgroup');
    group.label = label;
    for (const l of languages) group.append(new Option(l.name, l.code));
    $('asrLang').append(group);
  }
  for (const [key, model] of Object.entries(EN_MODELS)) $('enModel').append(new Option(model.label, key));
  $('target').append(new Option("Don't translate", 'off'));
  for (const t of TARGETS) $('target').append(new Option(t.name, t.code));
}

function note(text, kind = '') {
  $('note').hidden = !text;
  $('note').textContent = text;
  $('note').className = `note ${kind}`;
}

function render() {
  const here = session?.tabId === tab?.id;
  const elsewhere = session && !here;

  $('toggle').textContent = here ? 'Stop captions' : elsewhere ? 'Move captions to this tab' : 'Start captions';
  $('toggle').classList.toggle('danger', here);
  $('state').textContent = !session ? '' : elsewhere ? 'On in another tab'
    : { listening: 'Live', error: 'Error' }[session.status] ?? 'Starting';
  $('state').dataset.state = here ? session.status : '';

  $('status').hidden = !(here && session.detail);
  if (here) {
    $('status').dataset.state = session.status;
    $('statusText').textContent = session.detail ?? '';
    const progress = session.status === 'loading' ? session.progress : null;
    $('barTrack').hidden = progress == null;
    $('bar').style.width = `${Math.round((progress ?? 0) * 100)}%`;
  }

  for (const key of ['asrLang', 'enModel', 'target']) $(key).value = settings[key];
  $('enModelField').hidden = settings.asrLang !== 'en';
  $('showOriginal').checked = settings.showOriginal;
  for (const b of $('fontSize').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.size === settings.fontSize));
  }
}

function save(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.local.set({ settings });
  render();
}

// Chrome downloads translation and language-detection packs on first use, but
// only in response to a user gesture, so start that here while we have one.
function prefetchLanguagePacks() {
  const { asrLang, target } = settings;
  if (asrLang === 'auto' && 'LanguageDetector' in self) {
    LanguageDetector.create().then((d) => d.destroy?.()).catch(() => {});
  }
  if (target === 'off' || asrLang === 'auto' || sameLanguage(asrLang, target) || !('Translator' in self)) return;
  const pair = `${languageName(asrLang)} → ${languageName(target)}`;
  Translator.create({
    sourceLanguage: asrLang,
    targetLanguage: target,
    monitor: (m) => m.addEventListener('downloadprogress', (e) => {
      if (e.loaded < 1) note(`Downloading ${pair} translation… ${Math.round(e.loaded * 100)}%`);
    }),
  }).then((translator) => {
    translator.destroy();
    if ($('note').textContent.startsWith('Downloading')) note('');
    chrome.runtime.sendMessage({ type: 'translation-downloaded' });
  }).catch((err) => note(`Can't translate ${pair}: ${err.message}`, 'error'));
}

function friendlyError(message = '') {
  if (/chrome pages|cannot be captured|webstore/i.test(message)) {
    return "Captions can't run on Chrome's own pages. Switch to a regular website tab.";
  }
  if (/not been invoked/i.test(message)) return 'Click the toolbar icon while on the tab you want captioned.';
  return message || 'Something went wrong starting captions.';
}

fillSelects();
render();

$('asrLang').addEventListener('change', (e) => {
  save({ asrLang: e.target.value });
  if (session) prefetchLanguagePacks();
});
$('enModel').addEventListener('change', (e) => save({ enModel: e.target.value }));
$('target').addEventListener('change', (e) => {
  save({ target: e.target.value });
  if (session) prefetchLanguagePacks();
});
$('showOriginal').addEventListener('change', (e) => save({ showOriginal: e.target.checked }));
$('fontSize').addEventListener('click', (e) => {
  const size = e.target.closest('button')?.dataset.size;
  if (size) save({ fontSize: size });
});

$('toggle').addEventListener('click', async () => {
  note('');
  if (session?.tabId === tab.id) {
    await chrome.runtime.sendMessage({ type: 'stop' });
    return;
  }
  prefetchLanguagePacks();
  $('toggle').disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id });
  $('toggle').disabled = false;
  if (!result?.ok) note(friendlyError(result?.error), 'error');
});

$('transcript').addEventListener('click', async () => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'session' in changes) {
    session = changes.session.newValue ?? null;
    render();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'notice' && !msg.target) note(msg.text);
});
