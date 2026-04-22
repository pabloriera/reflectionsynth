const DEFAULTS = {
  T: 3.0,
  sigma: 0.1,
  secondAmplitude: -0.17,
  secondT: 1.0,
  secondSigma: 0.1,
  cutoffMultiplier: 4.0,
  Z: 1.0,
  k: 0.25,
  gain: 0.25,
  p: 3.0,
  qc: -0.1,
  smoothness: 30.0,
  newtonIters: 10,
  active: false,
};

const CONTROL_GROUPS = [
  {
    title: 'Reflection function',
    controls: [
      {
        id: 'T',
        label: 'T₁',
        min: 0.25,
        max: 30,
        step: 0.01,
        format: (value) => `${value.toFixed(2)} ms`,
      },
      {
        id: 'sigma',
        label: 'σ₁',
        min: 0.01,
        max: 4,
        step: 0.01,
        format: (value) => `${value.toFixed(2)} ms`,
      },
      {
        id: 'secondAmplitude',
        label: 'A₂',
        min: -1,
        max: 1,
        step: 0.01,
        format: (value) => value.toFixed(2),
      },
      {
        id: 'secondT',
        label: 'T₂',
        min: 0,
        max: 30,
        step: 0.01,
        format: (value) => `${value.toFixed(2)} ms`,
      },
      {
        id: 'secondSigma',
        label: 'σ₂',
        min: 0.01,
        max: 4,
        step: 0.01,
        format: (value) => `${value.toFixed(2)} ms`,
      },
      {
        id: 'cutoffMultiplier',
        label: 'max time',
        min: 1,
        max: 10,
        step: 0.1,
        format: (value) => `${value.toFixed(1)}σ`,
      },
      {
        id: 'Z',
        label: 'Z',
        min: 0.1,
        max: 4,
        step: 0.01,
        format: (value) => value.toFixed(2),
      },
    ],
  },
  {
    title: 'Nonlinear transfer function F(q)',
    controls: [
      {
        id: 'k',
        label: 'k',
        min: 0.01,
        max: 2,
        step: 0.01,
        format: (value) => value.toFixed(2),
      },
      {
        id: 'p',
        label: 'p',
        min: -2,
        max: 8,
        step: 0.01,
        format: (value) => value.toFixed(2),
      },
      {
        id: 'qc',
        label: 'qc',
        min: -2,
        max: 2,
        step: 0.01,
        format: (value) => value.toFixed(2),
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
  latestScope: new Float32Array(512),
  latestQ: 0,
  latestF: 0,
  latestHist: 0,
  latestRms: 0,
};

const elements = {
  controlsRoot: document.getElementById('controlsRoot'),
  toggleAudio: document.getElementById('toggleAudio'),
  resetSolver: document.getElementById('resetSolver'),
  gainSlider: document.getElementById('gainSlider'),
  gainValue: document.getElementById('gainValue'),
  sampleRateValue: document.getElementById('sampleRateValue'),
  kernelLengthValue: document.getElementById('kernelLengthValue'),
  currentQValue: document.getElementById('currentQValue'),
  currentFValue: document.getElementById('currentFValue'),
  statusText: document.getElementById('statusText'),
  statusSubtext: document.getElementById('statusSubtext'),
  waveformMeta: document.getElementById('waveformMeta'),
  reflectionMeta: document.getElementById('reflectionMeta'),
  transferMeta: document.getElementById('transferMeta'),
  waveformCanvas: document.getElementById('waveformCanvas'),
  reflectionCanvas: document.getElementById('reflectionCanvas'),
  transferCanvas: document.getElementById('transferCanvas'),
};

function tanh(value) {
  return Math.tanh(value);
}

function evaluateF(q, params = state) {
  const smoothStep = 0.5 * (1 + tanh(params.smoothness * (q - params.qc)));
  return params.k * (params.p - q) * (q - params.qc) * smoothStep;
}

function computeReflectionKernel(sampleRate = runtime.sampleRate, params = state) {
  const dtMs = 1000 / sampleRate;
  const sigma = Math.max(params.sigma, dtMs * 0.25);
  const secondSigma = Math.max(params.secondSigma, dtMs * 0.25);
  const endTime = Math.max(
    params.T + params.cutoffMultiplier * sigma,
    params.secondT + params.cutoffMultiplier * secondSigma
  );
  const length = Math.max(2, Math.ceil(endTime / dtMs) + 1);
  const kernel = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const timeMs = index * dtMs;
    const normalizedPrimary = (timeMs - params.T) / sigma;
    const normalizedSecondary = (timeMs - params.secondT) / secondSigma;
    kernel[index] =
      -Math.exp(-0.5 * normalizedPrimary * normalizedPrimary) +
      params.secondAmplitude * Math.exp(-0.5 * normalizedSecondary * normalizedSecondary);
  }

  kernel[0] = 0;
  return kernel;
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

  input.addEventListener('input', () => {
    state[control.id] = control.id === 'newtonIters'
      ? Math.round(Number(input.value))
      : Number(input.value);
    updateUi();
    postParams();
  });

  wrapper.append(label, input, value);
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
      const value = state[control.id];
      const valueNode = document.getElementById(`${control.id}Value`);
      if (valueNode) {
        valueNode.textContent = control.format(value);
      }
    }
  }

  elements.gainSlider.value = String(state.gain);
  elements.gainValue.textContent = state.gain.toFixed(3);
  elements.sampleRateValue.textContent = runtime.audioContext
    ? `fs ${runtime.audioContext.sampleRate} Hz`
    : 'fs pending';

  const kernel = computeReflectionKernel(runtime.audioContext?.sampleRate ?? runtime.sampleRate, state);
  elements.kernelLengthValue.textContent = `${kernel.length} taps`;
  elements.currentQValue.textContent = runtime.latestQ.toFixed(4);
  elements.currentFValue.textContent = runtime.latestF.toFixed(4);
  elements.statusText.textContent = state.active ? 'Audio running' : 'Audio idle';
  elements.statusSubtext.textContent = state.active
    ? 'Realtime causal solve running in the worklet.'
    : 'Press Start Audio to create the worklet.';
  elements.waveformMeta.textContent = `RMS ${runtime.latestRms.toFixed(4)} · latest history ${runtime.latestHist.toFixed(4)}`;
  elements.reflectionMeta.textContent = `T1 ${state.T.toFixed(2)} ms · T2 ${state.secondT.toFixed(2)} ms · amp2 ${state.secondAmplitude.toFixed(2)}`;
  elements.transferMeta.textContent = `Marker at q = ${runtime.latestQ.toFixed(4)}, F(q) = ${runtime.latestF.toFixed(4)}`;
  elements.toggleAudio.textContent = state.active ? 'Stop Audio' : 'Start Audio';
}

function postParams() {
  if (!runtime.node) {
    return;
  }

  runtime.node.port.postMessage({
    type: 'params',
    value: {
      ...state,
      newtonIters: Math.round(state.newtonIters),
    },
  });
}

async function ensureAudio() {
  if (runtime.audioContext) {
    return;
  }

  runtime.audioContext = new AudioContext();
  runtime.sampleRate = runtime.audioContext.sampleRate;
  await runtime.audioContext.audioWorklet.addModule('./worklet-processor.js');

  runtime.node = new AudioWorkletNode(runtime.audioContext, 'reflecton-notebook-processor', {
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  runtime.gainNode = runtime.audioContext.createGain();
  applyOutputGain();

  runtime.node.connect(runtime.gainNode);
  runtime.gainNode.connect(runtime.audioContext.destination);
  runtime.node.port.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'unstable') {
      state.active = false;
      elements.statusText.textContent = 'Unstable — stopped';
      elements.statusSubtext.textContent = 'Simulation diverged. Adjust parameters and press Start Audio.';
      elements.toggleAudio.textContent = 'Start Audio';
      return;
    }
    if (message.type !== 'state') {
      return;
    }

    runtime.latestScope = message.scope;
    runtime.latestQ = message.q;
    runtime.latestF = message.f;
    runtime.latestHist = message.hist;
    runtime.latestRms = message.rms;
    updateUi();
  };

  elements.sampleRateValue.textContent = `fs ${runtime.audioContext.sampleRate} Hz`;
  postParams();
}

function resetSolver() {
  if (!runtime.node) {
    runtime.latestScope = new Float32Array(512);
    runtime.latestQ = 0;
    runtime.latestF = 0;
    runtime.latestHist = 0;
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

  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
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
  context.fillText(xLabel, width - padding.right - 72, height - 10);

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
  const samples = runtime.latestScope;

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
  drawAxesLabels(context, width, height, padding, 'ms', 'q');
  drawSeries(context, points, width, height, padding, [0, xMaxMs || 1], yRange, '#0e6d6a');

  const zeroY = height - padding.bottom - ((0 - yRange[0]) / (yRange[1] - yRange[0] || 1)) * (height - padding.top - padding.bottom);
  context.strokeStyle = 'rgba(191, 75, 34, 0.22)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, zeroY);
  context.lineTo(width - padding.right, zeroY);
  context.stroke();
}

function drawReflection() {
  const { context, width, height } = getContext2d(elements.reflectionCanvas);
  const padding = { left: 40, right: 18, top: 18, bottom: 28 };
  const kernel = computeReflectionKernel(runtime.audioContext?.sampleRate ?? runtime.sampleRate, state);
  const dtMs = 1000 / (runtime.audioContext?.sampleRate ?? runtime.sampleRate);
  const xMax = (kernel.length - 1) * dtMs;
  const points = Array.from(kernel, (value, index) => [index * dtMs, value]);

  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, padding, 6, 4);
  drawAxesLabels(context, width, height, padding, 'ms', 'r');
  drawSeries(context, points, width, height, padding, [0, xMax || 1], [-1.1, 0.1], '#bf4b22');
}

function computeTransferRange() {
  const span = Math.max(1.5, Math.abs(state.p - state.qc) * 1.35);
  const center = (state.p + state.qc) * 0.5;
  return [center - span, center + span];
}

function drawTransfer() {
  const { context, width, height } = getContext2d(elements.transferCanvas);
  const padding = { left: 44, right: 18, top: 18, bottom: 28 };
  const [minQ, maxQ] = computeTransferRange();
  const steps = 256;
  const points = [];
  let minF = Infinity;
  let maxF = -Infinity;

  for (let index = 0; index < steps; index += 1) {
    const q = minQ + ((maxQ - minQ) * index) / (steps - 1);
    const f = evaluateF(q);
    points.push([q, f]);
    minF = Math.min(minF, f);
    maxF = Math.max(maxF, f);
  }

  if (Math.abs(maxF - minF) < 1e-6) {
    maxF += 1;
    minF -= 1;
  }

  const yPad = 0.08 * (maxF - minF);
  const yRange = [minF - yPad, maxF + yPad];

  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, padding, 6, 4);
  drawAxesLabels(context, width, height, padding, 'q', 'F(q)');
  drawSeries(context, points, width, height, padding, [minQ, maxQ], yRange, '#845ec2');

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const markerX = padding.left + ((runtime.latestQ - minQ) / (maxQ - minQ || 1)) * plotWidth;
  const markerY = height - padding.bottom - ((runtime.latestF - yRange[0]) / (yRange[1] - yRange[0] || 1)) * plotHeight;

  context.fillStyle = '#bf4b22';
  context.beginPath();
  context.arc(markerX, markerY, 5, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = 'rgba(191, 75, 34, 0.3)';
  context.beginPath();
  context.moveTo(markerX, padding.top);
  context.lineTo(markerX, height - padding.bottom);
  context.stroke();
}

function render() {
  drawWaveform();
  drawReflection();
  drawTransfer();
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

elements.gainSlider.addEventListener('input', (event) => {
  state.gain = Number(event.target.value);
  applyOutputGain();
  updateUi();
});

elements.resetSolver.addEventListener('click', () => {
  resetSolver();
});

window.addEventListener('resize', () => updateUi());

renderControls();
updateUi();
render();