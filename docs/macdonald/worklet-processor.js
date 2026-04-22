const SCOPE_SIZE = 512;

class MacdonaldProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.params = {
      tau: 0.9,
      beta: -2.1,
      gamma: 1.0,
      meanDelay: 4.0,
      p: 3,
      xHistory: 0.2,
      substeps: 4,
      method: 'rk4',
      active: false,
    };

    this.state = new Float64Array(5);
    this.k1 = new Float64Array(5);
    this.k2 = new Float64Array(5);
    this.k3 = new Float64Array(5);
    this.k4 = new Float64Array(5);
    this.temp = new Float64Array(5);
    this.a = 1;

    this.xScopeBuffer = new Float32Array(SCOPE_SIZE);
    this.zScopeBuffer = new Float32Array(SCOPE_SIZE);
    this.scopeIndex = 0;
    this.scopeEnergy = 0;

    this.latestX = 0;
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
    this.params.beta = Number(this.params.beta);
    this.params.gamma = Number(this.params.gamma);
    this.params.meanDelay = Math.max(0.05, Number(this.params.meanDelay));
    this.params.p = Math.max(0, Math.min(32, Math.round(Number(this.params.p))));
    this.params.xHistory = Number(this.params.xHistory);
    this.params.substeps = Math.max(1, Math.min(64, Math.round(Number(this.params.substeps))));
    this.params.method = this.params.method === 'euler' ? 'euler' : 'rk4';
    this.params.active = Boolean(this.params.active);
  }

  applyParams(overrides, forceReset) {
    const oldP = this.params.p;
    this.sanitizeParams(overrides);
    this.a = (this.params.p + 1) / this.params.meanDelay;

    if (forceReset || oldP !== this.params.p || this.state.length !== this.params.p + 2) {
      this.resizeState(forceReset);
    }
  }

  resizeState(forceReset) {
    const oldState = this.state;
    const newLength = this.params.p + 2;
    const nextState = new Float64Array(newLength);
    const xSeed = forceReset ? this.params.xHistory : (oldState[0] ?? this.params.xHistory);
    const chainSeed = forceReset
      ? this.params.xHistory
      : (oldState[oldState.length - 1] ?? this.params.xHistory);

    nextState[0] = xSeed;
    for (let index = 1; index < newLength; index += 1) {
      nextState[index] = index < oldState.length ? oldState[index] : chainSeed;
    }

    this.state = nextState;
    this.k1 = new Float64Array(newLength);
    this.k2 = new Float64Array(newLength);
    this.k3 = new Float64Array(newLength);
    this.k4 = new Float64Array(newLength);
    this.temp = new Float64Array(newLength);

    this.latestX = this.state[0];
    this.latestZ = this.state[newLength - 1];
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
    this.latestZ = this.params.xHistory;
    this.dcX = 0;
    this.dcY = 0;
    this.reportState();
  }

  derivative(state, out) {
    const x = state[0];
    const z = state[state.length - 1];

    out[0] = (this.params.beta * Math.tanh(this.params.gamma * z) - x) / this.params.tau;
    out[1] = this.a * (x - state[1]);

    for (let index = 2; index < state.length; index += 1) {
      out[index] = this.a * (state[index - 1] - state[index]);
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
    const count = Math.max(1, this.scopeIndex || SCOPE_SIZE);
    const rms = Math.sqrt(this.scopeEnergy / count);
    this.port.postMessage({
      type: 'state',
      xScope: this.xScopeBuffer.slice(),
      zScope: this.zScopeBuffer.slice(),
      chain: Float32Array.from(this.state.slice(1)),
      x: this.latestX,
      z: this.latestZ,
      a: this.a,
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
      this.latestZ = this.state[this.state.length - 1];

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

registerProcessor('macdonald-processor', MacdonaldProcessor);