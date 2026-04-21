const DEFAULTS = {
  T: 1000 / 440,
  tau: 0.1,
  sigma: 8.0,
  beta: 10.0,
  Z0S: 0.1,
  alpha: 5.0,
  P0: 5.0,
  pf: -1.0,
  smoothness: 30.0,
  substeps: 8,
  active: false,
};

const CONTROL_GROUPS = [
  {
    title: 'Reflection function',
    controls: [
      {
        id: 'T',
        label: 'T',
        min: 0.1,
        max: 100,
        step: 0.1,
        format: (v) => `${v.toFixed(1)} ms`,
      },
      {
        id: 'sigma',
        label: 'σ',
        min: 0.01,
        max: 30,
        step: 0.01,
        format: (v) => v.toFixed(2),
      },
      {
        id: 'beta',
        label: 'β',
        min: -30,
        max: 30,
        step: 0.1,
        format: (v) => v.toFixed(1),
      },
      {
        id: 'Z0S',
        label: 'Z₀/S',
        min: 0,
        max: 2,
        step: 0.001,
        format: (v) => v.toFixed(3),
      },
    ],
  },
  {
    title: 'Reed & Nonlinearity',
    controls: [
      {
        id: 'tau',
        label: 'τ',
        min: 0.005,
        max: 5.0,
        step: 0.005,
        format: (v) => `${v.toFixed(3)} ms`,
      },
      {
        id: 'alpha',
        label: 'α',
        min: 0.1,
        max: 30,
        step: 0.1,
        format: (v) => v.toFixed(1),
      },
      {
        id: 'P0',
        label: 'P₀',
        min: -5,
        max: 10,
        step: 0.1,
        format: (v) => v.toFixed(1),
      },
      {
        id: 'pf',
        label: 'pf',
        min: -5,
        max: 5,
        step: 0.1,
        format: (v) => v.toFixed(1),
      },
    ],
  },
];

const state = { ...DEFAULTS };

const runtime = {
  audioContext: null,
  node: null,
  sampleRate: 48000,
  latestPScope: new Float32Array(512),
  latestUScope: new Float32Array(512),
  latestP: 0,
  latestU: 0,
  latestFnl: 0,
  latestRms: 0,
};

const elements = {
  controlsRoot: document.getElementById('controlsRoot'),
  toggleAudio: document.getElementById('toggleAudio'),
  resetSolver: document.getElementById('resetSolver'),
  sampleRateValue: document.getElementById('sampleRateValue'),
  delayMValue: document.getElementById('delayMValue'),
  currentPValue: document.getElementById('currentPValue'),
  currentFnlValue: document.getElementById('currentFnlValue'),
  statusText: document.getElementById('statusText'),
  statusSubtext: document.getElementById('statusSubtext'),
  waveformMeta: document.getElementById('waveformMeta'),
  phaseMeta: document.getElementById('phaseMeta'),
  transferMeta: document.getElementById('transferMeta'),
  waveformCanvas: document.getElementById('waveformCanvas'),
  phaseCanvas: document.getElementById('phaseCanvas'),
  reflectionCanvas: document.getElementById('reflectionCanvas'),
  reflectionMeta: document.getElementById('reflectionMeta'),
  transferCanvas: document.getElementById('transferCanvas'),
};

function evaluateFnl(p, params = state) {
  const smoothStep = 0.5 * (1.0 + Math.tanh(params.smoothness * (p - params.pf)));
  return params.alpha * (params.P0 - p) * (p - params.pf) * smoothStep;
}

function computeDelayM(sr = runtime.sampleRate, params = state) {
  const dtMs = 1000 / sr;
  return Math.max(1, Math.round(params.T / dtMs));
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
  zero.setAttribute('aria-label', `Zero ${control.label}`);
  zero.addEventListener('click', () => {
    const clamped = Math.min(control.max, Math.max(control.min, 0));
    input.value = String(clamped);
    state[control.id] = clamped;
    updateUi();
    postParams();
  });

  input.addEventListener('input', () => {
    state[control.id] = Number(input.value);
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

function updateUi() {
  for (const group of CONTROL_GROUPS) {
    for (const control of group.controls) {
      const valueNode = document.getElementById(`${control.id}Value`);
      if (valueNode) {
        valueNode.textContent = control.format(state[control.id]);
      }
    }
  }

  const sr = runtime.audioContext?.sampleRate ?? runtime.sampleRate;
  elements.sampleRateValue.textContent = runtime.audioContext ? `${sr} Hz` : 'pending';
  elements.delayMValue.textContent = `${computeDelayM(sr)} smp`;
  elements.currentPValue.textContent = runtime.latestP.toFixed(4);
  elements.currentFnlValue.textContent = runtime.latestFnl.toFixed(4);
  elements.statusText.textContent = state.active ? 'Audio running' : 'Audio idle';
  elements.statusSubtext.textContent = state.active
    ? 'Realtime explicit-Euler DDE running in the worklet.'
    : 'Press Start Audio to begin.';
  elements.waveformMeta.textContent =
    `RMS ${runtime.latestRms.toFixed(4)} · p = ${runtime.latestP.toFixed(4)}`;
  elements.phaseMeta.textContent =
    `T = ${state.T.toFixed(1)} ms · M = ${computeDelayM(sr)} smp`;
  elements.transferMeta.textContent =
    `p = ${runtime.latestP.toFixed(4)}, ƒ(p) = ${runtime.latestFnl.toFixed(4)}`;
  elements.toggleAudio.textContent = state.active ? 'Stop Audio' : 'Start Audio';
}

function postParams() {
  if (!runtime.node) {
    return;
  }
  runtime.node.port.postMessage({ type: 'params', value: { ...state } });
}

async function ensureAudio() {
  if (runtime.audioContext) {
    return;
  }

  runtime.audioContext = new AudioContext();
  runtime.sampleRate = runtime.audioContext.sampleRate;
  await runtime.audioContext.audioWorklet.addModule('./worklet-processor.js');

  runtime.node = new AudioWorkletNode(runtime.audioContext, 'barjau-processor', {
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  runtime.node.connect(runtime.audioContext.destination);

  runtime.node.port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'unstable') {
      state.active = false;
      elements.statusText.textContent = 'Unstable — stopped';
      elements.statusSubtext.textContent = 'Simulation diverged. Adjust parameters and press Start Audio.';
      elements.toggleAudio.textContent = 'Start Audio';
      return;
    }
    if (msg.type !== 'state') {
      return;
    }
    runtime.latestPScope = msg.pScope;
    runtime.latestUScope = msg.uScope;
    runtime.latestP = msg.p;
    runtime.latestU = msg.u;
    runtime.latestFnl = msg.fnlP;
    runtime.latestRms = msg.rms;
    updateUi();
  };

  elements.sampleRateValue.textContent = `${runtime.audioContext.sampleRate} Hz`;
  postParams();
}

function resetSolver() {
  if (!runtime.node) {
    runtime.latestPScope = new Float32Array(512);
    runtime.latestUScope = new Float32Array(512);
    runtime.latestP = 0;
    runtime.latestU = 0;
    runtime.latestFnl = 0;
    runtime.latestRms = 0;
    updateUi();
    return;
  }
  runtime.node.port.postMessage({ type: 'reset' });
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

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

// ── Plot 1: Waveform p(t) ─────────────────────────────────────────────────────

function findTrigger(samples) {
  // Rising zero-crossing trigger: find the first index where the signal
  // crosses from negative (or zero) to positive, starting from index 1
  // so we have a full window after it. Search only the first half to
  // guarantee a full window of samples after the trigger point.
  const limit = Math.floor(samples.length / 2);
  for (let i = 1; i < limit; i += 1) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      return i;
    }
  }
  // Fallback: no crossing found, start from 0
  return 0;
}

function drawWaveform() {
  const { context, width, height } = getContext2d(elements.waveformCanvas);
  const padding = { left: 40, right: 18, top: 18, bottom: 28 };
  const samples = runtime.latestPScope;

  const triggerIdx = findTrigger(samples);
  // Display half the buffer length starting from the trigger point
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
  drawAxesLabels(context, width, height, padding, 'ms', 'p');
  drawSeries(context, points, width, height, padding, [0, xMaxMs || 1], yRange, '#0e6d6a');

  // Zero line
  const zeroY =
    height -
    padding.bottom -
    ((0 - yRange[0]) / (yRange[1] - yRange[0] || 1)) *
      (height - padding.top - padding.bottom);
  context.strokeStyle = 'rgba(191, 75, 34, 0.22)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, zeroY);
  context.lineTo(width - padding.right, zeroY);
  context.stroke();
}

// ── Plot 2: Phase portrait (u vs p) ──────────────────────────────────────────

function drawPhase() {
  const { context, width, height } = getContext2d(elements.phaseCanvas);
  const padding = { left: 44, right: 18, top: 18, bottom: 28 };
  const pSamples = runtime.latestPScope;
  const uSamples = runtime.latestUScope;
  const n = pSamples.length;

  let maxP = 0.02;
  let maxU = 0.02;
  for (let i = 0; i < n; i += 1) {
    maxP = Math.max(maxP, Math.abs(pSamples[i]));
    maxU = Math.max(maxU, Math.abs(uSamples[i]));
  }

  const xRange = [-maxP * 1.15, maxP * 1.15];
  const yRange = [-maxU * 1.15, maxU * 1.15];
  const points = Array.from({ length: n }, (_, i) => [pSamples[i], uSamples[i]]);

  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, padding, 4, 4);
  drawAxesLabels(context, width, height, padding, 'p', 'u');
  drawSeries(context, points, width, height, padding, xRange, yRange, '#6b57b8');

  // Current state dot
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const dotX = padding.left + ((runtime.latestP - xRange[0]) / (xRange[1] - xRange[0] || 1)) * plotW;
  const dotY = height - padding.bottom - ((runtime.latestU - yRange[0]) / (yRange[1] - yRange[0] || 1)) * plotH;

  context.fillStyle = '#bf4b22';
  context.beginPath();
  context.arc(dotX, dotY, 5, 0, Math.PI * 2);
  context.fill();
}

// ── Plot 3: Reflection r(t) ──────────────────────────────────────────────────

function drawReflection() {
  const { context, width, height } = getContext2d(elements.reflectionCanvas);
  const padding = { left: 44, right: 18, top: 18, bottom: 28 };
  const sr = runtime.audioContext?.sampleRate ?? runtime.sampleRate;
  const dtMs = 1000 / sr;
  const { sigma, beta, T } = state;

  // Render the causal exponential: r(t) = beta * exp(-sigma*(t-T)) for t >= T
  const displayEnd = T + (sigma > 0 ? Math.min(8 / sigma, 100) : 20);
  const steps = 512;
  const points = [];
  let minR = Infinity;
  let maxR = -Infinity;

  for (let i = 0; i < steps; i += 1) {
    const t = (displayEnd * i) / (steps - 1);
    const r = t >= T ? -beta * Math.exp(-sigma * (t - T)) : 0;
    points.push([t, r]);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }

  if (Math.abs(maxR - minR) < 1e-6) { maxR += 1; minR -= 1; }
  const yPad = 0.08 * (maxR - minR);
  const yRange = [minR - yPad, maxR + yPad];

  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height, padding, 6, 4);
  drawAxesLabels(context, width, height, padding, 'ms', 'r');
  drawSeries(context, points, width, height, padding, [0, displayEnd || 1], yRange, '#0d6e6e');

  // Y-axis tick labels
  const plotH = height - padding.top - padding.bottom;
  const yTickCount = 4;
  context.fillStyle = 'rgba(39, 23, 14, 0.6)';
  context.font = '10px IBM Plex Mono, monospace';
  context.textAlign = 'right';
  for (let i = 0; i <= yTickCount; i += 1) {
    const frac = i / yTickCount;
    const val = yRange[1] - frac * (yRange[1] - yRange[0]);
    const ty = padding.top + frac * plotH;
    context.fillText(val.toFixed(1), padding.left - 4, ty + 3.5);
  }
  context.textAlign = 'left';

  // Zero line
  const zeroY = height - padding.bottom - ((0 - yRange[0]) / (yRange[1] - yRange[0] || 1)) * plotH;
  context.strokeStyle = 'rgba(39, 23, 14, 0.15)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, zeroY);
  context.lineTo(width - padding.right, zeroY);
  context.stroke();

  // T marker
  const plotW = width - padding.left - padding.right;
  const tX = padding.left + (T / (displayEnd || 1)) * plotW;
  context.save();
  context.strokeStyle = 'rgba(191, 75, 34, 0.5)';
  context.lineWidth = 1.5;
  context.setLineDash([4, 3]);
  context.beginPath();
  context.moveTo(tX, padding.top);
  context.lineTo(tX, height - padding.bottom);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = 'rgba(191, 75, 34, 0.7)';
  context.font = '11px ui-monospace, monospace';
  context.fillText('T', tX + 3, padding.top + 12);
  context.restore();

  elements.reflectionMeta.textContent =
    `T=${T.toFixed(2)} ms · σ=${sigma.toFixed(2)} · β=${beta.toFixed(1)}`;
}

// ── Plot 4: Transfer ƒ(p) ──────────────────────────────────────────────────

function computeTransferRange() {
  const lo = Math.min(state.pf, state.P0);
  const hi = Math.max(state.pf, state.P0);
  const margin = Math.max(0.5, 0.4 * (hi - lo));
  return [lo - margin, hi + margin];
}

function drawTransfer() {
  const { context, width, height } = getContext2d(elements.transferCanvas);
  const padding = { left: 44, right: 18, top: 18, bottom: 28 };
  const [minP, maxP] = computeTransferRange();
  const steps = 256;
  const points = [];
  let minF = Infinity;
  let maxF = -Infinity;

  for (let i = 0; i < steps; i += 1) {
    const p = minP + ((maxP - minP) * i) / (steps - 1);
    const f = evaluateFnl(p);
    points.push([p, f]);
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
  drawAxesLabels(context, width, height, padding, 'p', 'ƒ(p)');
  drawSeries(context, points, width, height, padding, [minP, maxP], yRange, '#bf5b17');

  // P0 and pf root markers
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  function drawRootLine(pVal, label, color) {
    const x = padding.left + ((pVal - minP) / (maxP - minP || 1)) * plotW;
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    context.setLineDash([5, 3]);
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, height - padding.bottom);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = color;
    context.font = '11px ui-monospace, monospace';
    context.fillText(label, x + 3, padding.top + 12);
    context.restore();
  }

  drawRootLine(state.P0, 'P₀', 'rgba(31, 95, 191, 0.7)');
  drawRootLine(state.pf, 'pf', 'rgba(107, 87, 184, 0.7)');

  // Current state marker
  const markerX =
    padding.left +
    ((runtime.latestP - minP) / (maxP - minP || 1)) * plotW;
  const markerY =
    height -
    padding.bottom -
    ((runtime.latestFnl - yRange[0]) / (yRange[1] - yRange[0] || 1)) * plotH;

  context.fillStyle = '#1f5fbf';
  context.beginPath();
  context.arc(markerX, markerY, 5, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = 'rgba(31, 95, 191, 0.3)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(markerX, padding.top);
  context.lineTo(markerX, height - padding.bottom);
  context.stroke();
}

// ── Render loop ───────────────────────────────────────────────────────────────

function render() {
  drawWaveform();
  drawPhase();
  drawReflection();
  drawTransfer();
  requestAnimationFrame(render);
}

// ── Event listeners ───────────────────────────────────────────────────────────

elements.toggleAudio.addEventListener('click', async () => {
  await ensureAudio();
  state.active = !state.active;

  if (state.active) {
    await runtime.audioContext.resume();
    resetSolver();
  }

  postParams();
  updateUi();
});

elements.resetSolver.addEventListener('click', () => {
  resetSolver();
});

document.getElementById('substepsInput').addEventListener('change', (event) => {
  const v = Math.max(1, Math.min(64, Math.round(Number(event.target.value))));
  event.target.value = String(v);
  state.substeps = v;
  postParams();
});

window.addEventListener('resize', () => updateUi());

window.addEventListener('keydown', async (event) => {
  if (event.code !== 'Space' || (event.target.tagName === 'INPUT' && event.target.type !== 'range')) {
    return;
  }
  event.preventDefault();
  await ensureAudio();
  await runtime.audioContext.resume();
  state.active = true;
  resetSolver();
  postParams();
  updateUi();
});

renderControls();
updateUi();
render();
