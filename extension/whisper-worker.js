// Runs Whisper (Transformers.js, WebGPU when available) off the offscreen
// document's main thread. One request at a time; the caller schedules.

import * as tf from './vendor/transformers/transformers.min.js';
import { createWhisper } from './lib/whisper-core.js';

const MODEL_ID = 'onnx-community/whisper-small';
let whisper = null;

const reply = (msg) => postMessage(msg);

async function load({ base, local }) {
  tf.env.localModelPath = base + 'models/';
  tf.env.allowLocalModels = local;
  tf.env.allowRemoteModels = true; // fallback when the model isn't bundled
  tf.env.useWasmCache = false; // the Cache API rejects chrome-extension:// URLs
  tf.env.backends.onnx.wasm.wasmPaths = {
    mjs: base + 'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: base + 'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
  };
  // The GPU does the heavy lifting; extra CPU threads would only burn battery.
  tf.env.backends.onnx.wasm.numThreads = 1;

  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  const device = adapter ? 'webgpu' : 'wasm';
  const dtype = !adapter
    ? { encoder_model: 'q8', decoder_model_merged: 'q8' }
    : { encoder_model: adapter.features.has('shader-f16') ? 'fp16' : 'fp32', decoder_model_merged: 'q4' };

  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, [p.loaded, p.total]);
    let loaded = 0, total = 0;
    for (const [l, t] of files.values()) { loaded += l; total += t; }
    reply({ type: 'progress', progress: loaded / total });
  };

  whisper = await createWhisper(tf, { modelId: MODEL_ID, device, dtype, progress_callback });
  // Compile the GPU kernels now rather than on the first real sentence.
  await whisper.transcribe(new Float32Array(16000), { language: 'en' });
  return { device };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      reply({ type: 'ok', id, result: await load(data) });
    } else if (type === 'transcribe') {
      const result = await whisper.transcribe(data.audio, data);
      reply({ type: 'ok', id, result });
    }
  } catch (err) {
    reply({ type: 'error', id, message: err?.message ?? String(err) });
  }
};
