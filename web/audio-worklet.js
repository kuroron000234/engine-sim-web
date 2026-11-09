// Plays 44.1 kHz mono int16 chunks streamed from the simulation worker.
class EngineSimOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 1 << 16;
    this.buf = new Float32Array(this.cap);
    this.r = 0;            // read position (fractional, in source samples)
    this.w = 0;            // write position (integer, in source samples)
    this.consumed = 0;
    this.step = 44100 / sampleRate;
    this.reportAt = 0;
    this.ext = null;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'port') {
        this.ext = e.data.port;
        this.ext.onmessage = (ev) => this.onChunk(ev.data);
        this.ext.postMessage({ reset: true });
        this.r = this.w = this.consumed = 0;
      }
    };
  }

  onChunk(d) {
    {
      if (d instanceof Int16Array) {
        for (let i = 0; i < d.length; ++i) {
          this.buf[this.w & (this.cap - 1)] = d[i] / 32768;
          this.w++;
        }
        // Too far behind: drop the oldest audio rather than build up latency.
        if (this.w - this.r > 44100 * 0.3) {
          const skip = Math.floor(this.w - this.r - 44100 * 0.08);
          this.r += skip;
          this.consumed += skip;
        }
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    const n = ch0.length;
    for (let i = 0; i < n; ++i) {
      let v = 0;
      if (this.w - this.r > 1) {
        const i0 = Math.floor(this.r);
        const f = this.r - i0;
        const a = this.buf[i0 & (this.cap - 1)];
        const b = this.buf[(i0 + 1) & (this.cap - 1)];
        v = a + (b - a) * f;
        const nr = this.r + this.step;
        this.consumed += Math.floor(nr) - i0;
        this.r = nr;
      }
      ch0[i] = v;
    }
    for (let c = 1; c < out.length; ++c) out[c].set(ch0);
    if (currentFrame >= this.reportAt) {
      this.reportAt = currentFrame + 512;
      if (this.ext) this.ext.postMessage({ consumed: this.consumed });
    }
    return true;
  }
}

registerProcessor('engine-sim-output', EngineSimOutput);
