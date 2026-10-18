// Mixes tab audio to mono, downsamples to 16 kHz, and posts 100 ms Int16 PCM blocks.
const TARGET_RATE = 16000;
const BLOCK = 1600;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0;
    this.carry = [];
    this.out = new Int16Array(BLOCK);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0].length) return true;
    const len = input[0].length, chs = input.length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < chs; c++) v += input[c][i];
      this.carry.push(v / chs);
    }
    // Box-filter decimation: each output sample averages the input samples it spans.
    while (this.pos + this.ratio <= this.carry.length) {
      const a = Math.floor(this.pos), b = Math.max(a + 1, Math.floor(this.pos + this.ratio));
      let sum = 0;
      for (let i = a; i < b; i++) sum += this.carry[i];
      const v = Math.max(-1, Math.min(1, sum / (b - a)));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === BLOCK) {
        this.port.postMessage(this.out, [this.out.buffer]);
        this.out = new Int16Array(BLOCK);
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    const drop = Math.floor(this.pos);
    this.carry = this.carry.slice(drop);
    this.pos -= drop;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
