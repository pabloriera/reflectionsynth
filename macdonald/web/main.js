const DEFAULTS = {
  tau: 0.9,
  beta: -5,
  meanDelay: 1.0,
  p: 3,
  xHistory: 0.2,
  gain: 0.1,
  substeps: 4,
  method: 'rk4',
  active: false,
};

const CONTROL_GROUPS = [
  {
    title: 'Dynamics',
    controls: [
      {
        id: 'tau',
        label: 'τ',
        ariaLabel: 'tau',
        min: 0.05,
        max: 8,
        step: 0.01,
        format: (v) => v.toFixed(2),
      },
      {
        id: 'beta',
        label: 'β',
        ariaLabel: 'beta',
        min: -8,
        max: 8,
        step: 0.01,
        format: (v) => v.toFixed(2),
      },
      {
        id: 'meanDelay',
        label: 'τ̄',
        ariaLabel: 'mean delay',
        min: 0.25,
        max: 40,
        step: 0.01,
        format: (v) => `${v.toFixed(2)} ms`,
      },
    ],
  },
  {
    title: 'History & Chain',
    controls: [
      {
        id: 'p',
        label: 'p',
        min: 0,
        max: 12,
        step: 1,
        format: (v) => `${Math.round(v)}`,
      },
      {
        id: 'xHistory',
        label: 'x₀',
        ariaLabel: 'x zero',
        min: -2,
        max: 2,
        step: 0.001,
        format: (v) => v.toFixed(3),
      },
    ],
  },
];

const state = { ...DEFAULTS };

const runtime = {
  audioContext: null,
  node: null,
  gainNode: null,
  sampleRate: 48000,
  latestXScope: new Float32Array(512),
  latestZScope: new Float32Array(512),
  latestChain: new Float32Array(state.p + 1),
  latestX: 0,
  latestZ: 0,
  latestA: 0,
  latestRms: 0,
};

const elements = {
  controlsRoot: document.getElementById('controlsRoot'),
  toggleAudio: document.getElementById('toggleAudio'),
  resetSolver: document.getElementById('resetSolver'),
  gainSlider: document.getElementById('gainSlider'),
  gainValue: document.getElementById('gainValue'),
  methodSelect: document.getElementById('methodSelect'),
  substepsInput: document.getElementById('substepsInput'),
  sampleRateValue: document.getElementById('sampleRateValue'),
  aValue: document.getElementById('aValue'),
  currentXValue: document.getElementById('currentXValue'),
  currentZValue: document.getElementById('currentZValue'),
  statusText: document.getElementById('statusText'),
  statusSubtext: document.getElementById('statusSubtext'),
  waveformMeta: document.getElementById('waveformMeta'),
  phaseMeta: document.getElementById('phaseMeta'),
  kernelMeta: document.getElementById('kernelMeta'),
  chainMeta: document.getElementById('chainMeta'),
  waveformCanvas: document.getElementById('waveformCanvas'),
  phaseCanvas: document.getElementById('phaseCanvas'),
  kernelCanvas: document.getElementById('kernelCanvas'),
  chainCanvas: document.getElementById('chainCanvas'),
};

function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i += 1) {
    result *= i;
  }
  return result;
}

function computeA(params = state) {
  return (Math.round(params.p) + 1) / Math.max(0.05, params.meanDelay);
}

function evaluateKernel(u, params = state) {
  const p = Math.max(0, Math.round(params.p));
  const a = computeA(params);
  return ((a ** (p + 1)) / factorial(p)) * (u ** p) * Math.exp(-a * u);
}

function createControlRow(control) {
  const wrapper = document.createElement('div');
  wrapper.className = 'slider-row';

  const label = document.createElement('label');
  label.htmlFor = control.id;
  label.textContent = control.label;

  const input = document.createElement('input');
  input.type = 'range';
  input.id = control.id;
  input.min = String(control.min);
  input.max = String(control.max);
  input.step = String(control.step);
  input.value = String(DEFAULTS[control.id]);

  const value = document.createElement('div');
  value.className = 'slider-value';
  value.id = `${control.id}Value`;

  const zero = document.createElement('button');
  zero.className = 'zero-btn';
  zero.title = 'Set to 0';
  zero.setAttribute('aria-label', `Zero ${control.ariaLabel ?? control.label}`);
  zero.addEventListener('click', () => {
    const clamped = Math.min(control.max, Math.max(control.min, 0));
    input.value = String(clamped);
    state[control.id] = control.step >= 1 ? Math.round(clamped) : clamped;
    updateUi();
    postParams();
  });

  input.addEventListener('input', () => {
    const raw = Number(input.value);
    state[control.id] = control.step >= 1 ? Math.round(raw) : raw;
    updateUi();
    postParams();
  });

  wrapper.append(label, input, zero, value);
  return wrapper;
}

function renderControls() {
  for (const group of CONTROL_GROUPS) {
    const section = document.createElement('section');
    section.className = 'control-group';

    const title = document.createElement('h2');
    title.textContent = group.title;

    const stack = document.createElement('div');
    stack.className = 'control-stack';

    for (const control of group.controls) {
      stack.append(createControlRow(control));
    }

    section.append(title, stack);
    elements.controlsRoot.append(section);
  }
}

function applyOutputGain() {
  if (runtime.gainNode && runtime.audioContext) {
    const now = runtime.audioContext.currentTime;
    runtime.gainNode.gain.cancelScheduledValues(now);
    runtime.gainNode.gain.setValueAtTime(runtime.gainNode.gain.value, now);
    runtime.gainNode.gain.linearRampToValueAtTime(state.gain, now + 0.01);
    runtime.gainNode.gain.value = state.gain;
  }
}

function updateUi() {
  for (const group of CONTROL_GROUPS) {
    for (const control of group.controls) {
      const valueNode = document.getElementById(`${control.id}Value`);
      if (valueNode) {
        valueNode.textContent = control.format(state[control.id]);
      }
    }
  }

  elements.methodSelect.value = state.method;
  elements.substepsInput.value = String(state.substeps);

  const sampleRate = runtime.audioContext?.sampleRate ?? runtime.sampleRate;
  const a = runtime.latestA || computeA();
  elements.gainSlider.value = String(state.gain);
  elements.gainValue.textContent = state.gain.toFixed(3);
  elements.sampleRateValue.textContent = runtime.audioContext ? `fs ${sampleRate} Hz` : 'fs pending';
  elements.aValue.textContent = a.toFixed(3);
  elements.currentXValue.textContent = runtime.latestX.toFixed(4);
  elements.currentZValue.textContent = runtime.latestZ.toFixed(4);
  elements.statusText.textContent = state.active ? 'Audio running' : 'Audio idle';
  elements.statusSubtext.textContent = state.active
    ? `Realtime ${state.method.toUpperCase()} chain solver with ${state.substeps} sub-steps.`
    : 'Press Start Audio to begin (space-bar).';
  elements.waveformMeta.textContent =
    `RMS ${runtime.latestRms.toFixed(4)} · p = ${Math.round(state.p)}`;
  elements.phaseMeta.textContent =
    `x = ${runtime.latestX.toFixed(4)} · z = ${runtime.latestZ.toFixed(4)}`;
  elements.kernelMeta.textContent =
    `mean delay = ${state.meanDelay.toFixed(2)} ms · a = ${a.toFixed(3)}`;
  elements.chainMeta.textContent =
    `${runtime.latestChain.length} chain states · method ${state.method.toUpperCase()}`;
  elements.toggleAudio.textContent = state.active ? 'Stop Audio' : 'Start Audio';
}

function postParams() {
  if (!runtime.node) {
    return;
  }
  runtime.node.port.postMessage({
    type: 'params',
    value: {
      p: Math.round(state.p),
      tau: state.tau,
      beta: state.beta,
      meanDelay: state.meanDelay,
      xHistory: state.xHistory,
      method: state.method,
      active: state.active,
      substeps: Math.max(1, Math.round(state.substeps)),
    },
  });
}

async function ensureAudio() {
  if (runtime.audioContext) {
    return;
  }

  runtime.audioContext = new AudioContext({ latencyHint: 'interactive' });
  runtime.sampleRate = runtime.audioContext.sampleRate;
  await runtime.audioContext.audioWorklet.addModule('./worklet-processor.js?v=20260421-tanhbeta');

  runtime.node = new AudioWorkletNode(runtime.audioContext, 'macdonald-processor', {
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  runtime.gainNode = runtime.audioContext.createGain();
  applyOutputGain();

  runtime.node.connect(runtime.gainNode);
  runtime.gainNode.connect(runtime.audioContext.destination);

  runtime.node.port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'unstable') {
      state.active = false;
      elements.statusText.textContent = 'Unstable - stopped';
      elements.statusSubtext.textContent =
        'Simulation diverged. Adjust parameters and press Start Audio.';
      elements.toggleAudio.textContent = 'Start Audio';
      return;
    }
    if (msg.type !== 'state') {
      return;
    }
    runtime.latestXScope = msg.xScope;
    runtime.latestZScope = msg.zScope;
    runtime.latestChain = msg.chain;
    runtime.latestX = msg.x;
    runtime.latestZ = msg.z;
    runtime.latestA = msg.a;
    runtime.latestRms = msg.rms;
    updateUi();
  };

  postParams();
}

function resetSolver() {
  if (!runtime.node) {
    runtime.latestXScope = new Float32Array(512);
    runtime.latestZScope = new Float32Array(512);
    runtime.latestChain = new Float32Array(Math.round(state.p) + 1);
    runtime.latestX = 0;
    runtime.latestZ = 0;
    runtime.latestA = computeA();
    runtime.latestRms = 0;
    updateUi();
    return;
  }

  runtime.node.port.postMessage({ type: 'reset' });
}

function getContext2d(canvas) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(180, canvas.clientWidth || 300);
  const height = Math.max(180, canvas.clientHeight || 200);

  if (
    canvas.width !== Math.round(width * ratio) ||
    canvas.height !== Math.round(height * ratio)
  ) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function drawGrid(context, width, height, padding, linesX = 4, linesY = 4) {
  context.strokeStyle = 'rgba(39, 23, 14, 0.08)';
  context.lineWidth = 1;

  for (let i = 0; i <= linesX; i += 1) {
    const x = padding.left + ((width - padding.left - padding.right) * i) / linesX;
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, height - padding.bottom);
    context.stroke();
  }

  for (let i = 0; i <= linesY; i += 1) {
    const y = padding.top + ((height - padding.top - padding.bottom) * i) / linesY;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }
}

function drawAxesLabels(context, width, height, padding, xLabel, yLabel) {
  context.fillStyle = 'rgba(39, 23, 14, 0.7)';
  context.font = '12px IBM Plex Mono, monospace';
  context.fillText(xLabel, width - padding.right - 32, height - 10);

  context.save();
  context.translate(16, height / 2 + 20);
  context.rotate(-Math.PI / 2);
  context.fillText(yLabel, 0, 0);
  context.restore();
}

function drawSeries(context, points, width, height, padding, xRange, yRange, color) {
  const xScale = (width - padding.left - padding.right) / (xRange[1] - xRange[0] || 1);
  const yScale = (height - padding.top - padding.bottom) / (yRange[1] - yRange[0] || 1);

  context.beginPath();
  points.forEach(([x, y], index) => {
    const px = padding.left + (x - xRange[0]) * xScale;
    const py = height - padding.bottom - (y - yRange[0]) * yScale;
    if (index === 0) {
      context.moveTo(px, py);
    } else {
      context.lineTo(px, py);
    }
  });
  context.strokeStyle = color;
  context.lineWidth = 2.2;
  context.stroke();
}

function findTrigger(samples) {
  const limit = Math.floor(samples.length / 2);
  for (let i = 1; i < limit; i += 1) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      return i;
    }
  }
  return 0;
}

function drawWaveform() {
  const { context, width, height } = getContext2d(elements.waveformCanvas);
  const padding = { left: 40, right: 18, top: 18, bottom: 28 };
  const samples = runtime.latestXScope;
  const triggerIdx = findTrigger(samples);
  const windowLen = Math.floor(samples.length / 2);

  let amplitude = 0.02;
  for (let i = triggerIdx; i < triggerIdx + windowLen; i += 1) {
    amplitude = Math.max(amplitude, Math.abs(samples[i]));
  }

  const sr = runtime.audioContext?.sampleRate ?? runtime.sampleRate;
  const xMaxMs = (windowLen / sr) * 1000;
  const yRange = [-amplitude * 1.1, amplitude * 1.1];
  const points = [];
  for (let i = 0; i < windowLen; i += 1) {
    points.push([(i / Math.max(1, windowLen - 1)) * xMaxMs, samples[triggerIdx + i]]);
  }

  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, padding, 6, 4);
  drawAxesLabels(context, width, height, padding, 'ms', 'x');
  drawSeries(context, points, width, height, padding, [0, xMaxMs || 1], yRange, '#0e6d6a');
}

function drawPhase() {
  const { context, width, height } = getContext2d(elements.phaseCanvas);
  const padding = { left: 44, right: 18, top: 18, bottom: 28 };
  const xSamples = runtime.latestXScope;
  const zSamples = runtime.latestZScope;
  const n = xSamples.length;

  let maxX = 0.02;
  let maxZ = 0.02;
  for (let i = 0; i < n; i += 1) {
    maxX = Math.max(maxX, Math.abs(xSamples[i]));
    maxZ = Math.max(maxZ, Math.abs(zSamples[i]));
  }

  const xRange = [-maxX * 1.15, maxX * 1.15];
  const yRange = [-maxZ * 1.15, maxZ * 1.15];
  const points = Array.from({ length: n }, (_, i) => [xSamples[i], zSamples[i]]);

  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, padding, 4, 4);
  drawAxesLabels(context, width, height, padding, 'x', 'z');
  drawSeries(context, points, width, height, padding, xRange, yRange, '#6b57b8');

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const dotX = padding.left + ((runtime.latestX - xRange[0]) / (xRange[1] - xRange[0] || 1)) * plotW;
  const dotY = height - padding.bottom - ((runtime.latestZ - yRange[0]) / (yRange[1] - yRange[0] || 1)) * plotH;

  context.fillStyle = '#bf4b22';
  context.beginPath();
  context.arc(dotX, dotY, 5, 0, Math.PI * 2);
  context.fill();
}

function drawKernel() {
  const { context, width, height } = getContext2d(elements.kernelCanvas);
  const padding = { left: 44, right: 18, top: 18, bottom: 28 };
  const uMax = Math.max(4 * state.meanDelay, state.meanDelay + 1);
  const steps = 256;
  const points = [];
  let maxKernel = 0.01;

  for (let i = 0; i < steps; i += 1) {
    const u = (uMax * i) / (steps - 1);
    const value = evaluateKernel(u);
    points.push([u, value]);
    maxKernel = Math.max(maxKernel, value);
  }

  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, padding, 6, 4);
  drawAxesLabels(context, width, height, padding, 'u (ms)', 'G');
  drawSeries(context, points, width, height, padding, [0, uMax], [0, maxKernel * 1.15], '#bf5b17');
}

function drawChain() {
  const { context, width, height } = getContext2d(elements.chainCanvas);
  const padding = { left: 44, right: 18, top: 18, bottom: 28 };
  const chain = runtime.latestChain;
  const n = chain.length;

  let maxAbs = 0.02;
  for (let i = 0; i < n; i += 1) {
    maxAbs = Math.max(maxAbs, Math.abs(chain[i]));
  }

  const yRange = [-maxAbs * 1.15, maxAbs * 1.15];
  const points = Array.from({ length: n }, (_, i) => [i, chain[i]]);

  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, padding, Math.max(2, n - 1), 4);
  drawAxesLabels(context, width, height, padding, 'j', 'y_j');
  drawSeries(context, points, width, height, padding, [0, Math.max(1, n - 1)], yRange, '#1f5fbf');
}

function render() {
  drawWaveform();
  drawPhase();
  drawKernel();
  drawChain();
  requestAnimationFrame(render);
}

elements.toggleAudio.addEventListener('click', async () => {
  await ensureAudio();
  state.active = !state.active;

  if (state.active) {
    await runtime.audioContext.resume();
    applyOutputGain();
    resetSolver();
  }

  postParams();
  updateUi();
});

elements.resetSolver.addEventListener('click', () => {
  resetSolver();
});

elements.methodSelect.addEventListener('change', (event) => {
  state.method = event.target.value === 'euler' ? 'euler' : 'rk4';
  postParams();
  updateUi();
});

elements.gainSlider.addEventListener('input', (event) => {
  state.gain = Number(event.target.value);
  applyOutputGain();
  updateUi();
});

elements.substepsInput.addEventListener('change', (event) => {
  const value = Math.max(1, Math.min(64, Math.round(Number(event.target.value))));
  event.target.value = String(value);
  state.substeps = value;
  postParams();
  updateUi();
});

window.addEventListener('resize', () => updateUi());

window.addEventListener('keydown', async (event) => {
  if (event.code !== 'Space' || (event.target.tagName === 'INPUT' && event.target.type !== 'range')) {
    return;
  }
  event.preventDefault();
  await ensureAudio();
  await runtime.audioContext.resume();
  applyOutputGain();
  state.active = true;
  resetSolver();
  postParams();
  updateUi();
});

renderControls();
updateUi();
render();