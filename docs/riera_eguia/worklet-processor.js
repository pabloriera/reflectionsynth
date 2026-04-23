const SCOPE_SIZE = 512;

class RieraEguiaProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.params = {
      tau: 0.9,
      beta1: 1.0,
      beta2: 1.0,
      beta: 10,
      fnlType: 'tanh',
      alpha: 5.0,
      P0: 5.0,
      pf: -1.0,
      smoothness: 30.0,
      meanDelay1: 3.0,
      meanDelay2: 7.0,
      p: 3,
      xHistory: 0.2,
      substeps: 4,
      method: 'rk4',
      active: false,
    };

    this.state = new Float64Array(9);
    this.k1 = new Float64Array(9);
    this.k2 = new Float64Array(9);
    this.k3 = new Float64Array(9);
    this.k4 = new Float64Array(9);
    this.temp = new Float64Array(9);
    this.a1 = 1;
    this.a2 = 1;

    this.xScopeBuffer = new Float32Array(SCOPE_SIZE);
    this.zScopeBuffer = new Float32Array(SCOPE_SIZE);
    this.scopeIndex = 0;
    this.scopeEnergy = 0;

    this.latestX = 0;
    this.latestZ1 = 0;
    this.latestZ2 = 0;
    this.latestZ = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.maxAmplitude = 1000;

    this.applyParams(this.params, true);

    this.port.onmessage = (event) => {
      const { type, value } = event.data;
      if (type === 'params') {
        this.applyParams(value, false);
      } else if (type === 'reset') {
        this.resetState();
      }
    };
  }

  sanitizeParams(overrides) {
    Object.assign(this.params, overrides);
    this.params.tau = Math.max(0.01, Number(this.params.tau));
    this.params.beta1 = Number(this.params.beta1);
    this.params.beta2 = Number(this.params.beta2);
    this.params.beta = Number(this.params.beta);
    this.params.fnlType = ['tanh', 'reed'].includes(this.params.fnlType)
      ? this.params.fnlType
      : 'tanh';
    this.params.alpha = Number(this.params.alpha);
    this.params.P0 = Number(this.params.P0);
    this.params.pf = Number(this.params.pf);
    this.params.smoothness = Math.max(0.01, Number(this.params.smoothness));
    this.params.meanDelay1 = Math.max(0.05, Number(this.params.meanDelay1));
    this.params.meanDelay2 = Math.max(0.05, Number(this.params.meanDelay2));
    this.params.p = Math.max(0, Math.min(32, Math.round(Number(this.params.p))));
    this.params.xHistory = Number(this.params.xHistory);
    this.params.substeps = Math.max(1, Math.min(64, Math.round(Number(this.params.substeps))));
    this.params.method = this.params.method === 'euler' ? 'euler' : 'rk4';
    this.params.active = Boolean(this.params.active);
  }

  applyParams(overrides, forceReset) {
    const oldP = this.params.p;
    this.sanitizeParams(overrides);
    this.a1 = (this.params.p + 1) / this.params.meanDelay1;
    this.a2 = (this.params.p + 1) / this.params.meanDelay2;

    if (forceReset || oldP !== this.params.p || this.state.length !== (2 * this.params.p + 3)) {
      this.resizeState(forceReset);
    }
  }

  resizeState(forceReset) {
    const oldState = this.state;
    const chainLength = this.params.p + 1;
    const newLength = 1 + 2 * chainLength;
    const nextState = new Float64Array(newLength);
    const xSeed = forceReset ? this.params.xHistory : (oldState[0] ?? this.params.xHistory);
    const oldChainLength = oldState.length > 1 ? (oldState.length - 1) / 2 : 0;
    const chain1Seed = forceReset
      ? this.params.xHistory
      : (oldChainLength > 0 ? oldState[oldChainLength] : this.params.xHistory);
    const chain2Seed = forceReset
      ? this.params.xHistory
      : (oldChainLength > 0 ? oldState[2 * oldChainLength] : this.params.xHistory);
    const secondChainStart = 1 + chainLength;
    const oldSecondChainStart = 1 + oldChainLength;

    nextState[0] = xSeed;
    for (let index = 0; index < chainLength; index += 1) {
      nextState[1 + index] = index < oldChainLength ? oldState[1 + index] : chain1Seed;
      nextState[secondChainStart + index] = index < oldChainLength
        ? oldState[oldSecondChainStart + index]
        : chain2Seed;
    }

    this.state = nextState;
    this.k1 = new Float64Array(newLength);
    this.k2 = new Float64Array(newLength);
    this.k3 = new Float64Array(newLength);
    this.k4 = new Float64Array(newLength);
    this.temp = new Float64Array(newLength);

    this.latestX = this.state[0];
    this.latestZ1 = this.state[chainLength];
    this.latestZ2 = this.state[2 * chainLength];
    this.latestZ = this.params.beta1 * this.latestZ1 + this.params.beta2 * this.latestZ2;
    if (forceReset) {
      this.resetState();
    }
  }

  resetState() {
    this.state.fill(this.params.xHistory);
    this.xScopeBuffer.fill(0);
    this.zScopeBuffer.fill(0);
    this.scopeIndex = 0;
    this.scopeEnergy = 0;
    this.latestX = this.params.xHistory;
    this.latestZ1 = this.params.xHistory;
    this.latestZ2 = this.params.xHistory;
    this.latestZ = this.params.beta1 * this.latestZ1 + this.params.beta2 * this.latestZ2;
    this.dcX = 0;
    this.dcY = 0;
    this.reportState();
  }

  fnl(z) {
    if (this.params.fnlType === 'reed') {
      const { alpha, P0, pf, smoothness } = this.params;
      const smoothStep = 0.5 * (1.0 + Math.tanh(smoothness * (z - pf)));
      return alpha * (P0 - z) * (z - pf) * smoothStep;
    }

    return Math.tanh(this.params.beta * z);
  }

  derivative(state, out) {
    const chainLength = this.params.p + 1;
    const chain2Start = 1 + chainLength;
    const x = state[0];
    const z1 = state[chainLength];
    const z2 = state[2 * chainLength];
    const z = this.params.beta1 * z1 + this.params.beta2 * z2;
    const fnl = this.fnl(z);

    out[0] = (-fnl - x) / this.params.tau;

    out[1] = this.a1 * (x - state[1]);
    for (let index = 1; index < chainLength; index += 1) {
      const target = 1 + index;
      out[target] = this.a1 * (state[target - 1] - state[target]);
    }

    out[chain2Start] = this.a2 * (x - state[chain2Start]);
    for (let index = 1; index < chainLength; index += 1) {
      const target = chain2Start + index;
      out[target] = this.a2 * (state[target - 1] - state[target]);
    }
  }

  integrateEuler(dt) {
    this.derivative(this.state, this.k1);
    for (let index = 0; index < this.state.length; index += 1) {
      this.state[index] += dt * this.k1[index];
    }
  }

  integrateRk4(dt) {
    this.derivative(this.state, this.k1);
    for (let index = 0; index < this.state.length; index += 1) {
      this.temp[index] = this.state[index] + 0.5 * dt * this.k1[index];
    }

    this.derivative(this.temp, this.k2);
    for (let index = 0; index < this.state.length; index += 1) {
      this.temp[index] = this.state[index] + 0.5 * dt * this.k2[index];
    }

    this.derivative(this.temp, this.k3);
    for (let index = 0; index < this.state.length; index += 1) {
      this.temp[index] = this.state[index] + dt * this.k3[index];
    }

    this.derivative(this.temp, this.k4);
    for (let index = 0; index < this.state.length; index += 1) {
      this.state[index] += (dt / 6) * (
        this.k1[index] + 2 * this.k2[index] + 2 * this.k3[index] + this.k4[index]
      );
    }
  }

  step(dt) {
    if (this.params.method === 'euler') {
      this.integrateEuler(dt);
      return;
    }
    this.integrateRk4(dt);
  }

  isUnstable() {
    for (let index = 0; index < this.state.length; index += 1) {
      const value = this.state[index];
      if (!Number.isFinite(value) || Math.abs(value) > this.maxAmplitude) {
        return true;
      }
    }
    return false;
  }

  dcBlock(sample) {
    const pole = 0.995;
    this.dcY = sample - this.dcX + pole * this.dcY;
    this.dcX = sample;
    return this.dcY;
  }

  pushScopeSamples(x, z) {
    this.xScopeBuffer[this.scopeIndex] = x;
    this.zScopeBuffer[this.scopeIndex] = z;
    this.scopeEnergy += x * x;
    this.scopeIndex += 1;

    if (this.scopeIndex >= SCOPE_SIZE) {
      this.reportState();
      this.scopeIndex = 0;
      this.scopeEnergy = 0;
    }
  }

  reportState() {
    const chainLength = this.params.p + 1;
    const secondChainStart = 1 + chainLength;
    const count = Math.max(1, this.scopeIndex || SCOPE_SIZE);
    const rms = Math.sqrt(this.scopeEnergy / count);
    this.port.postMessage({
      type: 'state',
      xScope: this.xScopeBuffer.slice(),
      zScope: this.zScopeBuffer.slice(),
      chain1: Float32Array.from(this.state.slice(1, secondChainStart)),
      chain2: Float32Array.from(this.state.slice(secondChainStart)),
      x: this.latestX,
      z1: this.latestZ1,
      z2: this.latestZ2,
      z: this.latestZ,
      a1: this.a1,
      a2: this.a2,
      rms,
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) {
      return true;
    }

    const channel = output[0];
    const dt = (1000 / sampleRate) / this.params.substeps;
    const chainLength = this.params.p + 1;

    for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
      if (!this.params.active) {
        channel[sampleIndex] = 0;
        this.pushScopeSamples(0, 0);
        continue;
      }

      for (let substep = 0; substep < this.params.substeps; substep += 1) {
        this.step(dt);
      }

      this.latestX = this.state[0];
      this.latestZ1 = this.state[chainLength];
      this.latestZ2 = this.state[2 * chainLength];
      this.latestZ = this.params.beta1 * this.latestZ1 + this.params.beta2 * this.latestZ2;

      if (this.isUnstable()) {
        this.params.active = false;
        channel[sampleIndex] = 0;
        this.resetState();
        this.port.postMessage({ type: 'unstable' });
        break;
      }

      const sample = this.dcBlock(this.latestX);
      channel[sampleIndex] = Number.isFinite(sample) ? sample : 0;
      this.pushScopeSamples(this.latestX, this.latestZ);
    }

    return true;
  }
}

registerProcessor('riera-eguia-processor', RieraEguiaProcessor);
