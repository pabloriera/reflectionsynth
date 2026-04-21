const HISTORY_SIZE = 16384;
const SCOPE_SIZE = 512;

class ReflectonNotebookProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.params = {
      T: 3.0,
      sigma: 0.1,
      secondAmplitude: -0.17,
      secondT: 1.0,
      secondSigma: 0.1,
      cutoffMultiplier: 4.0,
      Z: 1.0,
      k: 0.25,
      p: 3.0,
      qc: -0.1,
      smoothness: 30.0,
      newtonIters: 10,
      outputGain: 0.75,
      active: false,
    };

    this.kernel = new Float64Array(2);
    this.kernel[0] = 0;
    this.kernel[1] = -1;

    this.qHistory = new Float64Array(HISTORY_SIZE);
    this.fHistory = new Float64Array(HISTORY_SIZE);
    this.combinedHistory = new Float64Array(HISTORY_SIZE);
    this.writeIndex = 0;

    this.scopeBuffer = new Float32Array(SCOPE_SIZE);
    this.scopeIndex = 0;
    this.scopeEnergy = 0;

    this.latestQ = 0;
    this.latestF = 0;
    this.latestHist = 0;
    this.dcX = 0;
    this.dcY = 0;

    this.rebuildKernel();

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'params') {
        Object.assign(this.params, message.value);
        this.params.newtonIters = Math.max(1, Math.round(this.params.newtonIters));
        this.rebuildKernel();
      } else if (message.type === 'reset') {
        this.resetState();
      }
    };
  }

  resetState() {
    this.qHistory.fill(0);
    this.fHistory.fill(0);
    this.combinedHistory.fill(0);
    this.writeIndex = 0;
    this.scopeBuffer.fill(0);
    this.scopeIndex = 0;
    this.scopeEnergy = 0;
    this.latestQ = 0;
    this.latestF = 0;
    this.latestHist = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.reportState();
  }

  rebuildKernel() {
    const dtMs = 1000 / sampleRate;
    const sigma = Math.max(this.params.sigma, dtMs * 0.25);
    const secondSigma = Math.max(this.params.secondSigma, dtMs * 0.25);
    const endTime = Math.max(
      this.params.T + this.params.cutoffMultiplier * sigma,
      this.params.secondT + this.params.cutoffMultiplier * secondSigma
    );
    const length = Math.min(HISTORY_SIZE - 1, Math.max(2, Math.ceil(endTime / dtMs) + 1));

    this.kernel = new Float64Array(length);
    for (let index = 0; index < length; index += 1) {
      const timeMs = index * dtMs;
      const normalizedPrimary = (timeMs - this.params.T) / sigma;
      const normalizedSecondary = (timeMs - this.params.secondT) / secondSigma;
      this.kernel[index] =
        -Math.exp(-0.5 * normalizedPrimary * normalizedPrimary) +
        this.params.secondAmplitude * Math.exp(-0.5 * normalizedSecondary * normalizedSecondary);
    }

    this.kernel[0] = 0;
  }

  evaluateF(q) {
    const { k, p, qc, smoothness } = this.params;
    const tanhValue = Math.tanh(smoothness * (q - qc));
    const smoothStep = 0.5 * (1 + tanhValue);
    return k * (p - q) * (q - qc) * smoothStep;
  }

  evaluateDF(q) {
    const { k, p, qc, smoothness } = this.params;
    const tanhValue = Math.tanh(smoothness * (q - qc));
    const smoothStep = 0.5 * (1 + tanhValue);
    const dsmoothStep = 0.5 * smoothness * (1 - tanhValue * tanhValue);

    return k * (
      -(q - qc) * smoothStep +
      (p - q) * smoothStep +
      (p - q) * (q - qc) * dsmoothStep
    );
  }

  dcBlock(sample) {
    const pole = 0.995;
    this.dcY = sample - this.dcX + pole * this.dcY;
    this.dcX = sample;
    return this.dcY;
  }

  computeHistory() {
    const dtMs = 1000 / sampleRate;
    let hist = 0;

    for (let tap = 1; tap < this.kernel.length; tap += 1) {
      const historyIndex = (this.writeIndex - tap + HISTORY_SIZE) % HISTORY_SIZE;
      hist += this.kernel[tap] * this.combinedHistory[historyIndex];
    }

    return hist * dtMs;
  }

  solveQ(hist) {
    const dtMs = 1000 / sampleRate;
    const r0 = this.kernel[0] || 0;
    const Z = this.params.Z;
    let qn = this.latestQ;

    for (let iter = 0; iter < this.params.newtonIters; iter += 1) {
      const Fn = this.evaluateF(qn);
      const dFn = this.evaluateDF(qn);
      const G = qn - hist - (1 + dtMs * r0) * Z * Fn - dtMs * r0 * qn;
      const dG = 1 - (1 + dtMs * r0) * Z * dFn - dtMs * r0;

      if (!Number.isFinite(G) || !Number.isFinite(dG) || Math.abs(dG) < 1e-8) {
        return 0;
      }

      const qNext = qn - G / dG;
      if (!Number.isFinite(qNext)) {
        return 0;
      }

      if (Math.abs(qNext - qn) < 1e-10) {
        qn = qNext;
        break;
      }

      qn = qNext;
    }

    return qn;
  }

  pushScopeSample(sample) {
    this.scopeBuffer[this.scopeIndex] = sample;
    this.scopeEnergy += sample * sample;
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
      scope: new Float32Array(this.scopeBuffer),
      q: this.latestQ,
      f: this.latestF,
      hist: this.latestHist,
      rms,
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) {
      return true;
    }

    const channel = output[0];

    for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
      if (!this.params.active) {
        channel[sampleIndex] = 0;
        this.pushScopeSample(0);
        continue;
      }

      const hist = this.computeHistory();
      const q = this.solveQ(hist);
      const f = this.evaluateF(q);
      const combined = q + this.params.Z * f;

      this.qHistory[this.writeIndex] = q;
      this.fHistory[this.writeIndex] = f;
      this.combinedHistory[this.writeIndex] = combined;
      this.writeIndex = (this.writeIndex + 1) % HISTORY_SIZE;

      this.latestQ = Number.isFinite(q) ? q : 0;
      this.latestF = Number.isFinite(f) ? f : 0;
      this.latestHist = Number.isFinite(hist) ? hist : 0;

      const heard = Math.tanh(this.params.outputGain * this.dcBlock(this.latestQ));
      channel[sampleIndex] = Number.isFinite(heard) ? heard : 0;
      this.pushScopeSample(this.latestQ);
    }

    return true;
  }
}

registerProcessor('reflecton-notebook-processor', ReflectonNotebookProcessor);

