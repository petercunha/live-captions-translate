#!/usr/bin/env node
// Downloads the speech models into extension/models/ so the extension runs
// fully offline. Anything not bundled here is fetched on demand at runtime
// (and cached by the browser), so this is about first-run speed, not function.
//
//   node scripts/fetch-models.mjs              # default set
//   node scripts/fetch-models.mjs medium tiny  # specific models
//   node scripts/fetch-models.mjs all

import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'models');

// Moonshine Streaming: the weights are published on Hugging Face under
// moonshine-ai/moonshine-streaming-{tiny,small,medium}; the quantized ONNX
// Runtime (.ort) build that the Moonshine WASM engine loads is served from
// Moonshine's CDN. File lists match the engine's own manifest.
const MOONSHINE_CDN = 'https://download.moonshine.ai/model';
const STREAMING_FILES = ['frontend.ort', 'encoder.ort', 'adapter.ort', 'cross_kv.ort',
  'decoder_kv.ort', 'streaming_config.json', 'tokenizer.bin'];
const moonshine = (size) => ({
  dir: `moonshine/${size}-streaming-en`,
  hf: `moonshine-ai/moonshine-streaming-${size}`,
  files: STREAMING_FILES.map((f) => [f, `${MOONSHINE_CDN}/${size}-streaming-en/quantized_26_07_30/${f}`]),
});

// Whisper (multilingual fallback) straight from the Hugging Face hub, laid out
// the way Transformers.js expects for a local model.
const HF = 'https://huggingface.co';
const whisper = (repo, encoder, decoder) => ({
  dir: repo,
  hf: repo,
  files: ['config.json', 'generation_config.json', 'preprocessor_config.json',
    'tokenizer.json', 'tokenizer_config.json', `onnx/${encoder}`, `onnx/${decoder}`]
    .map((f) => [f, `${HF}/${repo}/resolve/main/${f}`]),
});

const MODELS = {
  small: moonshine('small'),
  medium: moonshine('medium'),
  tiny: moonshine('tiny'),
  whisper: whisper('onnx-community/whisper-small', 'encoder_model_fp16.onnx', 'decoder_model_merged_q4.onnx'),
};
const DEFAULT = ['small', 'whisper'];

async function sizeOf(path) {
  try { return (await stat(path)).size; } catch { return -1; }
}

async function download(url, dest) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const expected = Number(head.headers.get('content-length')) || -1;
  if (expected > 0 && (await sizeOf(dest)) === expected) return 'cached';

  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const got = await sizeOf(tmp);
  if (expected > 0 && got !== expected) throw new Error(`size mismatch for ${url}: ${got} != ${expected}`);
  await rename(tmp, dest);
  return `${(got / 1e6).toFixed(1)} MB`;
}

const args = process.argv.slice(2);
const wanted = args.includes('all') ? Object.keys(MODELS) : (args.length ? args : DEFAULT);
for (const name of wanted) {
  const model = MODELS[name];
  if (!model) {
    console.error(`unknown model "${name}" (choose from: ${Object.keys(MODELS).join(', ')}, all)`);
    process.exit(1);
  }
  console.log(`\n${name}  (${model.hf})`);
  for (const [file, url] of model.files) {
    const result = await download(url, join(ROOT, model.dir, file));
    console.log(`  ${file.padEnd(36)} ${result}`);
  }
}
