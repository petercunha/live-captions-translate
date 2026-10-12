// Whisper transcription with per-segment language detection, on top of
// Transformers.js. The library is passed in so the same code runs in the
// extension's worker (web build) and in Node tests.
//
// Transformers.js does not detect the spoken language itself (it falls back to
// English, which makes Whisper translate rather than transcribe), so we run the
// encoder once, read the language-token logits from a single decoder step, and
// then generate from the same encoder output.

export async function createWhisper(tf, { modelId, device, dtype, progress_callback }) {
  const { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, Tensor } = tf;
  const [processor, tokenizer, model] = await Promise.all([
    AutoProcessor.from_pretrained(modelId, { progress_callback }),
    AutoTokenizer.from_pretrained(modelId, { progress_callback }),
    WhisperForConditionalGeneration.from_pretrained(modelId, { device, dtype, progress_callback }),
  ]);

  const config = model.generation_config;
  const languages = Object.entries(config.lang_to_id).map(([token, id]) => ({ code: token.slice(2, -2), id }));
  const startIds = new Tensor('int64', BigInt64Array.from([BigInt(config.decoder_start_token_id)]), [1, 1]);

  async function encode(audio) {
    const { input_features } = await processor(audio);
    const { encoder_outputs } = await model._prepare_encoder_decoder_kwargs_for_generation({
      inputs_tensor: input_features,
      model_inputs: { input_features },
      model_input_name: 'input_features',
      generation_config: config,
    });
    return { input_features, encoder_outputs };
  }

  async function detectLanguage(encoder_outputs) {
    const { logits } = await model({ encoder_outputs, decoder_input_ids: startIds });
    const vocab = logits.dims.at(-1);
    const offset = logits.data.length - vocab;
    const scores = languages.map(({ id }) => Number(logits.data[offset + id]));
    const max = Math.max(...scores);
    const weights = scores.map((s) => Math.exp(s - max));
    const total = weights.reduce((a, b) => a + b, 0);
    let best = 0;
    for (let i = 1; i < weights.length; i++) if (weights[i] > weights[best]) best = i;
    return { language: languages[best].code, probability: weights[best] / total };
  }

  /**
   * @param {Float32Array} audio 16 kHz mono PCM, at most 30 s.
   * @param {object} options
   * @param {string|null} [options.language] language code, or null to detect it.
   * @param {string|null} [options.fallbackLanguage] used instead of a detection
   *   whose probability is below `minProbability` (e.g. the language of the
   *   last few segments).
   */
  async function transcribe(audio, { language = null, fallbackLanguage = null, minProbability = 0.6 } = {}) {
    const { input_features, encoder_outputs } = await encode(audio);
    let probability = 1;
    let detected = null;
    if (!language) {
      ({ language: detected, probability } = await detectLanguage(encoder_outputs));
      language = probability < minProbability && fallbackLanguage ? fallbackLanguage : detected;
    }
    // Caps runaway repetition on music/noise; speech rarely exceeds ~10 tokens/s.
    const seconds = audio.length / 16000;
    const max_new_tokens = Math.min(224, Math.ceil(16 + seconds * 12));
    const ids = await model.generate({
      inputs: input_features,
      encoder_outputs,
      language,
      task: 'transcribe',
      max_new_tokens,
    });
    const text = tokenizer.batch_decode(ids, { skip_special_tokens: true })[0].trim();
    return { text, language, detected, probability };
  }

  return { transcribe, dispose: () => model.dispose() };
}
