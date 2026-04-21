// HISTORY_SIZE must be a power of 2 for fast bitwise modulo.
// At 48 kHz this supports delays up to ~1.36 s.
const HISTORY_SIZE = 65536;
const SCOPE_SIZE = 512;

class BarjauProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.params = {
      T: 1000 / 440, // delay in ms (period of 440 Hz)
      tau: 0.1,       // reed time-constant in ms
      sigma: 8.0,     // wave-guide loss coefficient (ms⁻¹)
      beta: 10.0,       // reflection coefficient (ms⁻¹)
      Z0S: 1.0,       // impedance ratio Z₀/S (dimensionless)
      alpha: 5.0,     // nonlinearity gain
      P0: 1.0,        // upper pressure root of fnl
      pf: -1.0,       // lower pressure root of fnl
      smoothness: 30.0, // sigmoid steepness
      substeps: 8,    // ODE sub-steps per audio sample
      active: false,
    };

    // Ring buffers for p(t) and u(t)
    this.pHistory = new Float64Array(HISTORY_SIZE);
    this.uHistory = new Float64Array(HISTORY_SIZE);
    // writeIndex points to the slot where the NEXT sample will be stored.
    // The last written sample (current state) is at writeIndex-1.
    this.writeIndex = 0;
    this.M = 1; // delay in samples, updated by updateM()

    // Oscilloscope buffers sent to the main thread
    this.pScopeBuffer = new Float32Array(SCOPE_SIZE);
    this.uScopeBuffer = new Float32Array(SCOPE_SIZE);
    this.scopeIndex = 0;
    this.scopeEnergy = 0;

    this.latestP = 0;
    this.latestU = 0;
    this.latestFnl = 0;

    // DC blocker state
    this.dcX = 0;
    this.dcY = 0;

    // Instability detection: ring buffer of last 3 |p| values
    this.absP = new Float64Array(3);
    this.absPIdx = 0;
    this.INSTABILITY_THRESHOLD = 1e6;

    this.updateM();

    this.port.onmessage = (event) => {
      const { type, value } = event.data;
      if (type === 'params') {
        Object.assign(this.params, value);
        this.updateM();
      } else if (type === 'reset') {
        this.resetState();
      }
    };
  }

  updateM() {
    const dtMs = 1000 / sampleRate;
    this.M = Math.max(1, Math.min(HISTORY_SIZE - 1, Math.round(this.params.T / dtMs)));
  }

  // Nonlinearity: fnl(p) = alpha * (P0 - p) * (p - pf) * smooth_step(p)
  fnl(p) {
    const { alpha, P0, pf, smoothness } = this.params;
    const smoothStep = 0.5 * (1.0 + Math.tanh(smoothness * (p - pf)));
    return alpha * (P0 - p) * (p - pf) * smoothStep;
  }

  resetState() {
    this.pHistory.fill(0);
    this.uHistory.fill(0);
    this.writeIndex = 0;
    this.pScopeBuffer.fill(0);
    this.uScopeBuffer.fill(0);
    this.scopeIndex = 0;
    this.scopeEnergy = 0;
    this.latestP = 0;
    this.latestU = 0;
    this.latestFnl = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.absP.fill(0);
    this.absPIdx = 0;
    this.reportState();
  }

  checkInstability(pAbs) {
    // Store the last 3 |p| values in a small ring buffer
    this.absP[this.absPIdx % 3] = pAbs;
    this.absPIdx += 1;

    if (this.absPIdx < 3) {
      return false;
    }

    // Average absolute increase over the last 3 steps
    const a = this.absP[(this.absPIdx - 3) % 3];
    const b = this.absP[(this.absPIdx - 2) % 3];
    const c = this.absP[(this.absPIdx - 1) % 3];
    const avgIncrease = ((Math.max(0, b - a) + Math.max(0, c - b)) / 2);

    return avgIncrease > this.INSTABILITY_THRESHOLD;
  }

  dcBlock(sample) {
    const pole = 0.995;
    this.dcY = sample - this.dcX + pole * this.dcY;
    this.dcX = sample;
    return this.dcY;
  }

  pushScopeSamples(p, u) {
    this.pScopeBuffer[this.scopeIndex] = p;
    this.uScopeBuffer[this.scopeIndex] = u;
    this.scopeEnergy += p * p;
    this.scopeIndex += 1;

    if (this.scopeIndex >= SCOPE_SIZE) {
      this.reportState();
      this.scopeIndex = 0;
      this.scopeEnergy = 0;
    }
  }

  reportState() {
    const rms = Math.sqrt(this.scopeEnergy / Math.max(1, this.scopeIndex || SCOPE_SIZE));
    this.port.postMessage({
      type: 'state',
      pScope: this.pScopeBuffer.slice(),
      uScope: this.uScopeBuffer.slice(),
      p: this.latestP,
      u: this.latestU,
      fnlP: this.latestFnl,
      rms,
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) {
      return true;
    }

    const channel = output[0];
    const dtMs = 1000 / sampleRate;
    const { tau, sigma, beta, Z0S } = this.params;
    const N = Math.max(1, Math.round(this.params.substeps));
    const dtSub = dtMs / N;
    const mask = HISTORY_SIZE - 1;

    for (let i = 0; i < channel.length; i += 1) {
      if (!this.params.active) {
        channel[i] = 0;
        this.pushScopeSamples(0, 0);
        continue;
      }

      // Delayed values are looked up once per audio frame (delay = M audio samples)
      const currIdx = (this.writeIndex - 1 + HISTORY_SIZE) & mask;
      const delayIdx = (this.writeIndex - 1 - this.M + HISTORY_SIZE) & mask;

      let pn = this.pHistory[currIdx];
      let un = this.uHistory[currIdx];
      const pDelay = this.pHistory[delayIdx];
      const uDelay = this.uHistory[delayIdx];

      // Sub-step the Euler integrator N times per audio sample.
      // Each sub-step uses dtSub = dtMs / N, keeping the delay values
      // fixed (they correspond to M audio frames ≈ T ms ago).
      for (let s = 0; s < N; s += 1) {
        const fnlV = this.fnl(pn);
        const uNext = un + (dtSub / tau) * (fnlV - un);
        const pNext = pn
          + dtSub * Z0S * ((fnlV - un) / tau + sigma * un - beta * uDelay)
          - dtSub * (sigma * pn + beta * pDelay);
        un = Number.isFinite(uNext) ? uNext : 0;
        pn = Number.isFinite(pNext) ? pNext : 0;
      }

      this.pHistory[this.writeIndex] = pn;
      this.uHistory[this.writeIndex] = un;
      this.writeIndex = (this.writeIndex + 1) & mask;

      this.latestP = pn;
      this.latestU = un;
      this.latestFnl = this.fnl(pn);

      if (this.checkInstability(Math.abs(pn))) {
        this.params.active = false;
        channel[i] = 0;
        this.resetState();
        this.port.postMessage({ type: 'unstable' });
        break;
      }

      channel[i] = Number.isFinite(pn) ? pn : 0;
      this.pushScopeSamples(pn, un);
    }

    return true;
  }
}

registerProcessor('barjau-processor', BarjauProcessor);
