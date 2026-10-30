// JERICHO DEW — plays the shared copy of the service on the phone, smoothly.
// Pieces of sound (20 ms each) arrive from the church PC; a small cushion (about 0.12 s) hides bumps in the internet.
// If the phone falls behind, old sound is dropped so the delay never grows.
class PgmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];          // [{ L, R }] pieces waiting
    this.cur = null; this.pos = 0;
    this.started = false;
    this.target = Math.round(0.12 * sampleRate);   // cushion before starting
    this.max = Math.round(0.45 * sampleRate);      // more than this waiting = drop the oldest
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.reset) { this.q = []; this.cur = null; this.pos = 0; this.started = false; return; }
      this.q.push(m);
      let have = this.buffered();
      while (have > this.max && this.q.length > 1) { const d = this.q.shift(); have -= d.L.length; }
    };
  }
  buffered() { let n = this.cur ? this.cur.L.length - this.pos : 0; for (const x of this.q) n += x.L.length; return n; }
  process(_in, outputs) {
    const out = outputs[0]; const l = out[0], r = out[1] || out[0];
    if (!this.started) { if (this.buffered() >= this.target) this.started = true; else return true; }
    for (let i = 0; i < l.length; i++) {
      if (!this.cur || this.pos >= this.cur.L.length) {
        this.cur = this.q.shift() || null; this.pos = 0;
        if (!this.cur) { this.started = false; for (let j = i; j < l.length; j++) { l[j] = 0; r[j] = 0; } return true; }   // ran dry: wait for a new cushion
      }
      l[i] = this.cur.L[this.pos]; r[i] = this.cur.R[this.pos]; this.pos++;
    }
    return true;
  }
}
registerProcessor('pgm-player', PgmPlayer);
