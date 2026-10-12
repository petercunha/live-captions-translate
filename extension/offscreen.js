// Offscreen document: the engine room. Captures the tab's audio, runs speech
// recognition (Moonshine or Whisper) and translation (Chrome's on-device
// Translator), and posts caption lines to the service worker.

import { SttWorkerHost } from './vendor/moonshine/index.js';
import { ARCH, EN_MODELS, languageName, sameLanguage, spokenLanguage } from './shared/languages.js';

const SAMPLE_RATE = 16000;
const STREAMING_FILES = ['frontend.ort', 'encoder.ort', 'adapter.ort', 'cross_kv.ort',
  'decoder_kv.ort', 'streaming_config.json', 'tokenizer.bin'];
const PARTIAL_TRANSLATE_MS = 700; // how often an in-progress line is re-translated
const WHISPER_PARTIAL_MS = 1500; // how often Whisper re-transcribes an in-progress line
const WHISPER_MAX_SECONDS = 28; // Whisper's window is 30 s
const MAX_BACKLOG_SECONDS = 8; // drop audio rather than fall further behind than this
const KEEP_LINES = 50;

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
const status = (state, detail, progress = null) => send({ type: 'status', status: state, detail, progress });

async function isBundled(path) {
  try {
    return (await fetch(chrome.runtime.getURL(path))).ok;
  } catch {
    return false;
  }
}

// --- audio capture --------------------------------------------------------------

async function startCapture(streamId, onPcm) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  const ctx = new AudioContext();
  await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination); // capturing a tab mutes it, so play it back

  await ctx.audioWorklet.addModule('capture-worklet.js');
  // Two low-pass stages keep content above 8 kHz from aliasing into the 16 kHz signal.
  const lowpass1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
  const lowpass2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 });
  const pcm = new AudioWorkletNode(ctx, 'pcm-16k', { channelCount: 1, channelCountMode: 'explicit' });
  pcm.port.onmessage = ({ data }) => onPcm(data);
  // The worklet outputs silence; connecting it keeps the graph pulling audio.
  source.connect(lowpass1).connect(lowpass2).connect(pcm).connect(ctx.destination);

  stream.getAudioTracks()[0]?.addEventListener('ended', () => send({ type: 'capture-ended' }));
  return {
    async stop() {
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}

// --- Moonshine: streaming English, plus per-language models -----------------------

class MoonshineEngine {
  constructor(language, size, onLine) {
    this.language = language;
    this.size = EN_MODELS[size] ? size : 'small';
    this.onLine = onLine;
  }

  get description() {
    return this.language.code === 'en' ? `Moonshine ${this.size}` : 'Moonshine';
  }

  async model() {
    if (this.language.code !== 'en') {
      // Fetched from the Moonshine CDN on first use, then cached by the browser.
      return { arch: this.language.arch, source: { kind: 'catalog', language: this.language.code } };
    }
    const dir = `models/moonshine/${this.size}-streaming-en/`;
    const source = (await isBundled(dir + 'streaming_config.json'))
      ? { kind: 'urls', files: Object.fromEntries(STREAMING_FILES.map((f) => [f, chrome.runtime.getURL(dir + f)])) }
      : { kind: 'catalog', language: 'en' };
    return { arch: EN_MODELS[this.size].arch, source };
  }

  async load(onProgress) {
    const { arch, source } = await this.model();
    this.host = new SttWorkerHost();
    this.host.onProgress = (_id, loaded, total) => onProgress(total ? loaded / total : null);
    await this.host.loadTranscriber({ transcriberId: 'asr', modelArch: arch, source });
    await this.host.createStream('asr', 'live');
    this.host.setListener('live', {
      onLineTextChanged: ({ line }) => this.emit(line, false),
      onLineCompleted: ({ line }) => this.emit(line, true),
      onError: ({ error }) => console.warn('[live-captions] moonshine:', error.message),
    });
    await this.host.start('live');
  }

  emit(line, final) {
    const text = line.text.trim();
    if (text) this.onLine({ id: line.id, start: line.startTime, text, final, lang: this.language.code });
  }

  feed(pcm) {
    if (this.host.queuedSeconds('live') > MAX_BACKLOG_SECONDS) return;
    this.host.addAudio('live', pcm, SAMPLE_RATE);
  }

  async stop() {
    try {
      await this.host?.stop('live'); // flushes the line in progress
    } catch { /* worker already gone */ }
    this.host?.close();
  }
}

// --- Whisper: any language, segmented by Moonshine's voice activity detector ------

class AudioRing {
  constructor(seconds) {
    this.size = seconds * SAMPLE_RATE;
    this.buf = new Float32Array(this.size);
    this.total = 0;
  }

  push(pcm) {
    const offset = this.total % this.size;
    const first = Math.min(pcm.length, this.size - offset);
    this.buf.set(pcm.subarray(0, first), offset);
    if (first < pcm.length) this.buf.set(pcm.subarray(first), 0);
    this.total += pcm.length;
  }

  // Copy of [from, to) seconds of stream time, or null once it has been overwritten.
  read(from, to) {
    const end = Math.min(Math.round(to * SAMPLE_RATE), this.total);
    const start = Math.max(Math.round(from * SAMPLE_RATE), this.total - this.size);
    if (end - start < SAMPLE_RATE * 0.1) return null;
    const out = new Float32Array(end - start);
    for (let i = 0; i < out.length;) {
      const pos = (start + i) % this.size;
      const n = Math.min(out.length - i, this.size - pos);
      out.set(this.buf.subarray(pos, pos + n), i);
      i += n;
    }
    return out;
  }
}

// Whisper's habit of captioning music and silence.
function cleanWhisperText(text) {
  const cleaned = text.replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /\p{L}/u.test(cleaned) ? cleaned : '';
}

class WhisperEngine {
  constructor(language, onLine) {
    this.language = language === 'auto' ? null : language;
    this.onLine = onLine;
    this.ring = new AudioRing(120);
    this.open = new Map(); // in-progress speech segments by id
    this.finals = []; // finished segments awaiting their final transcription
    this.lastPartial = new Map();
    this.recent = []; // recent language detections, for a sticky language
    this.pending = new Map();
    this.nextId = 0;
    this.busy = false;
    this.stopped = false;
    this.device = null;
  }

  get description() {
    return `Whisper small${this.device === 'webgpu' ? ' · WebGPU' : ''}`;
  }

  async load(onProgress) {
    // Silero VAD from the Moonshine runtime finds the speech segments; with
    // skip_transcription it needs no speech model of its own.
    this.vad = new SttWorkerHost();
    await this.vad.loadTranscriber({
      transcriberId: 'vad',
      modelArch: ARCH.base,
      source: { kind: 'urls', files: {} },
      options: { skip_transcription: 'true' },
    });
    await this.vad.createStream('vad', 'live');
    this.vad.setListener('live', {
      onLineUpdated: ({ line }) => this.onSegment(line),
      onLineCompleted: ({ line }) => this.onSegment(line),
    });
    await this.vad.start('live');

    this.worker = new Worker('whisper-worker.js', { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress') return onProgress(data.progress);
      const slot = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.type === 'ok') slot?.resolve(data.result);
      else slot?.reject(new Error(data.message));
    };
    this.worker.onerror = (event) => {
      for (const slot of this.pending.values()) slot.reject(new Error(event.message || 'Whisper worker crashed'));
      this.pending.clear();
    };
    const local = await isBundled('models/onnx-community/whisper-small/config.json');
    ({ device: this.device } = await this.call({ type: 'load', base: chrome.runtime.getURL(''), local }));
  }

  call(message, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  feed(pcm) {
    this.ring.push(pcm);
    this.vad.addAudio('live', pcm, SAMPLE_RATE);
  }

  onSegment(line) {
    const seg = { id: line.id, start: line.startTime, end: line.startTime + line.duration, final: line.isComplete };
    if (seg.final) {
      this.open.delete(seg.id);
      this.lastPartial.delete(seg.id);
      if (seg.end - seg.start >= 0.3) this.finals.push(seg);
    } else {
      this.open.set(seg.id, seg);
    }
    this.pump();
  }

  // Finished segments first; otherwise refresh an in-progress one now and then.
  nextJob() {
    if (this.finals.length) return this.finals.shift();
    const now = performance.now();
    for (const seg of this.open.values()) {
      if (seg.end - seg.start >= 1 && now - (this.lastPartial.get(seg.id) ?? 0) >= WHISPER_PARTIAL_MS) {
        this.lastPartial.set(seg.id, now);
        return seg;
      }
    }
    return null;
  }

  async pump() {
    if (this.busy || this.stopped) return;
    const job = this.nextJob();
    if (!job) return;
    this.busy = true;
    try {
      const text = await this.transcribe(job);
      if (text && !this.stopped) {
        this.onLine({ id: job.id, start: job.start, text, final: job.final, lang: this.lastLanguage });
      }
    } catch (err) {
      if (!this.stopped) console.warn('[live-captions] whisper:', err.message);
    } finally {
      this.busy = false;
    }
    this.pump();
  }

  async transcribe(job) {
    // Partials only look at the latest window; finals are split into pieces.
    const pieces = [];
    for (let from = job.final ? job.start : Math.max(job.start, job.end - WHISPER_MAX_SECONDS); from < job.end - 0.05;) {
      const to = Math.min(job.end, from + WHISPER_MAX_SECONDS);
      pieces.push([from, to]);
      from = to;
    }
    const texts = [];
    for (const [from, to] of pieces) {
      const audio = this.ring.read(from, to);
      if (!audio) continue;
      const sticky = this.stickyLanguage();
      const result = await this.call({
        type: 'transcribe',
        audio,
        // In auto mode, finals re-detect the language; partials reuse the recent one.
        language: this.language ?? (job.final ? null : sticky),
        fallbackLanguage: sticky,
        minProbability: 0.7,
      }, [audio.buffer]);
      if (!this.language && result.detected) this.vote(result.detected, result.probability);
      this.lastLanguage = result.language;
      texts.push(cleanWhisperText(result.text));
    }
    return texts.join(' ').trim();
  }

  // Text-based language detection of a finished line (more reliable than
  // Whisper's audio guess on accented speech) steers the sticky language.
  hint(language, confidence) {
    if (!this.language) this.vote(language.split('-')[0], 1.5 * confidence);
  }

  vote(language, probability) {
    this.recent.push({ language, probability });
    if (this.recent.length > 6) this.recent.shift();
  }

  stickyLanguage() {
    const scores = new Map();
    for (const { language, probability } of this.recent) scores.set(language, (scores.get(language) ?? 0) + probability);
    let best = null;
    for (const [language, score] of scores) if (!best || score > scores.get(best)) best = language;
    return best;
  }

  async stop() {
    this.stopped = true;
    try {
      await this.vad?.stop('live');
    } catch { /* already gone */ }
    this.vad?.close();
    this.worker?.terminate();
    for (const slot of this.pending.values()) slot.reject(new Error('stopped'));
    this.pending.clear();
  }
}

// --- translation (Chrome's built-in, on-device Translator API) --------------------

class Translations {
  constructor() {
    this.target = null;
    this.translators = new Map(); // "src>tgt" -> Promise<Translator | null>
    this.blockedUntil = new Map();
  }

  setTarget(target) {
    if (target === this.target) return;
    this.target = target;
    for (const entry of this.translators.values()) entry.then((t) => t?.destroy()).catch(() => {});
    this.translators.clear();
  }

  // A language pack finished downloading elsewhere (popup or overlay).
  retry() {
    this.blockedUntil.clear();
  }

  async translate(text, source) {
    const target = this.target;
    if (!target || !text || !source || sameLanguage(source, target) || typeof Translator === 'undefined') return null;
    const translator = await this.get(source, target);
    if (!translator || target !== this.target) return null;
    return translator.translate(text);
  }

  get(source, target) {
    const key = `${source}>${target}`;
    if ((this.blockedUntil.get(key) ?? 0) > Date.now()) return null;
    let entry = this.translators.get(key);
    if (!entry) {
      entry = this.create(source, target, key);
      this.translators.set(key, entry);
    }
    return entry;
  }

  async create(source, target, key) {
    const pair = `${languageName(source)} → ${languageName(target)}`;
    const availability = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
    if (availability === 'unavailable') {
      send({ type: 'notice', text: `Chrome can't translate ${pair}.` });
      return null; // stays cached: no point asking again
    }
    try {
      const translator = await Translator.create({
        sourceLanguage: source,
        targetLanguage: target,
        monitor: (m) => m.addEventListener('downloadprogress', (e) => {
          if (e.loaded > 0 && e.loaded < 1) send({ type: 'notice', text: `Downloading ${pair} translation… ${Math.round(e.loaded * 100)}%` });
        }),
      });
      send({ type: 'translation-ready', source, target });
      return translator;
    } catch (err) {
      // Downloading a language pack needs a user gesture, which this hidden
      // page can't get. The overlay offers a button; retry when it reports back.
      console.warn(`[live-captions] translator ${key}:`, err.message);
      this.translators.delete(key);
      this.blockedUntil.set(key, Date.now() + 10_000);
      send({ type: 'translation-needs-download', source, target, pair });
      return null;
    }
  }
}

let detector;
async function detectTextLanguage(text) {
  if (text.length < 12 || typeof LanguageDetector === 'undefined') return null;
  detector ??= LanguageDetector.create().catch(() => {
    // Not downloaded yet (that needs a user gesture); try again later.
    setTimeout(() => (detector = undefined), 15_000);
    return null;
  });
  const instance = await detector;
  if (!instance) return null;
  const [best] = await instance.detect(text);
  return best && best.confidence >= 0.5 && best.detectedLanguage !== 'und'
    ? { language: best.detectedLanguage, confidence: best.confidence } : null;
}

// --- caption lines ----------------------------------------------------------------

let settings = null;
let capture = null;
let engine = null;
let engineGeneration = 0;
const translations = new Translations();
const lines = new Map();

function onLine({ id, start, text, final, lang }) {
  let line = lines.get(id);
  if (!line) {
    line = { id, start, text: '', translation: '', final: false, seq: 0, timer: null, lastTranslated: 0 };
    lines.set(id, line);
    if (lines.size > KEEP_LINES) lines.delete(lines.keys().next().value);
  }
  if (line.final && !final) return; // a late partial
  if (line.text === text && line.final === final) return;
  Object.assign(line, { text, final, lang });
  emit(line);
  scheduleTranslation(line);
}

function emit(line) {
  const { id, start, text, translation, final } = line;
  send({ type: 'caption', line: { id, start, text, translation, final, lang: line.source ?? line.lang } });
}

function scheduleTranslation(line) {
  clearTimeout(line.timer);
  line.timer = null;
  if (!translations.target) return;
  if (line.final) return void translateLine(line);
  const wait = Math.max(0, PARTIAL_TRANSLATE_MS - (performance.now() - line.lastTranslated));
  line.timer = setTimeout(() => translateLine(line), wait);
}

async function sourceLanguage(line) {
  if (settings.asrLang !== 'auto') return settings.asrLang;
  if (line.source) return line.source;
  // Text-based detection is more reliable than Whisper's audio guess, which can
  // mistake accented speech for English.
  const detected = await detectTextLanguage(line.text).catch(() => null);
  const source = detected?.language ?? line.lang;
  if (line.final) {
    line.source = source;
    if (detected) engine?.hint?.(detected.language, detected.confidence);
  }
  return source;
}

async function translateLine(line) {
  line.timer = null;
  const seq = ++line.seq;
  line.lastTranslated = performance.now();
  try {
    const translation = await translations.translate(line.text, await sourceLanguage(line));
    if (seq !== line.seq || translation == null) return;
    line.translation = translation;
    emit(line);
  } catch (err) {
    console.warn('[live-captions] translate:', err.message);
  }
}

function retranslateRecent() {
  for (const line of [...lines.values()].slice(-3)) {
    line.translation = '';
    line.lastTranslated = 0;
    scheduleTranslation(line);
  }
}

// --- engine lifecycle ---------------------------------------------------------------

async function startEngine() {
  const generation = ++engineGeneration;
  const previous = engine;
  engine = null;
  await previous?.stop();

  const language = spokenLanguage(settings.asrLang);
  const next = language.engine === 'whisper'
    ? new WhisperEngine(language.code, onLine)
    : new MoonshineEngine(language, settings.enModel, onLine);
  const current = () => generation === engineGeneration;

  status('loading', 'Loading speech model…', 0);
  try {
    await next.load((progress) => current() && status('loading', 'Loading speech model…', progress));
  } catch (err) {
    next.stop();
    if (current()) status('error', `Couldn't load the speech model: ${err.message}`);
    return;
  }
  if (!current()) return void next.stop();
  engine = next;
  const target = translations.target ? ` → ${languageName(translations.target)}` : '';
  status('listening', `Listening · ${language.name}${target} · ${next.description}`);
}

async function applySettings(next) {
  const restart = next.asrLang !== settings.asrLang ||
    (next.asrLang === 'en' && next.enModel !== settings.enModel);
  const retarget = next.target !== settings.target;
  settings = next;
  translations.setTarget(next.target === 'off' ? null : next.target);
  if (restart && capture) await startEngine();
  else if (retarget) {
    retranslateRecent();
    if (engine) {
      const target = translations.target ? ` → ${languageName(translations.target)}` : '';
      status('listening', `Listening · ${spokenLanguage(next.asrLang).name}${target} · ${engine.description}`);
    }
  }
}

const handlers = {
  async start({ streamId, settings: initial }) {
    settings = initial;
    translations.setTarget(initial.target === 'off' ? null : initial.target);
    capture = await startCapture(streamId, (pcm) => engine?.feed(pcm));
    startEngine(); // reports its progress through status messages
  },
  async settings({ settings: next }) {
    if (settings) await applySettings(next);
  },
  async stop() {
    engineGeneration++;
    await engine?.stop();
    engine = null;
    await capture?.stop();
    capture = null;
  },
  async 'retry-translation'() {
    translations.retry();
    retranslateRecent();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || !handlers[msg.type]) return false;
  handlers[msg.type](msg).then(
    () => sendResponse({ ok: true }),
    (err) => {
      console.warn(`[live-captions] ${msg.type} failed:`, err);
      sendResponse({ ok: false, error: err?.message ?? String(err) });
    },
  );
  return true;
});

send({ type: 'offscreen-ready' });
