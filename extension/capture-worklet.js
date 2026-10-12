// Resamples the (already low-passed, mono) tab audio to 16 kHz and posts it to
// the offscreen document in 100 ms chunks.

const TARGET_RATE = 16000;
const CHUNK = 1600;

class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.pos = 0; // next output position, in input samples relative to this block (may be in [-1, 0))
    this.prev = 0; // last input sample of the previous block
    this.out = new Float32Array(CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const n = input.length;
    let pos = this.pos;
    while (pos < n - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.prev : input[i];
      this.out[this.filled++] = a + (input[i + 1] - a) * frac;
      if (this.filled === CHUNK) {
        this.port.postMessage(this.out, [this.out.buffer]);
        this.out = new Float32Array(CHUNK);
        this.filled = 0;
      }
      pos += this.step;
    }
    this.pos = pos - n;
    this.prev = input[n - 1];
    return true;
  }
}

registerProcessor('pcm-16k', Pcm16k);
