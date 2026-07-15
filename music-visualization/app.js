const $ = (selector) => document.querySelector(selector);

const ui = {
  canvas: $("#visualizer"),
  start: $("#startButton"),
  startLabel: $("#startButton strong"),
  status: $("#status"),
};

const canvasContext = ui.canvas.getContext("2d", { alpha: true });
const bandCount = 24;
const idleSpectrum = new Float32Array(bandCount).fill(0.015);
const previousSpectrum = new Float32Array(bandCount).fill(0.015);

const visualizations = [
  { id: "1", draw: drawMirroredSpectrum },
  { id: "2", draw: drawPrismaticVortex },
  { id: "3", draw: drawStellarBloom },
];

const requestedVisualization = new URL(window.location.href).searchParams.get("visualization");
const requestedVisualizationIndex = visualizations.findIndex(({ id }) => id === requestedVisualization);

const features = {
  bass: 0,
  mids: 0,
  treble: 0,
  energy: 0,
  flux: 0,
  beatPulse: 0,
  beatCount: 0,
  bpm: null,
  lastBeatAt: -Infinity,
  lastFrameAt: 0,
};

let displayStream = null;
let audioContext = null;
let sourceNode = null;
let analyser = null;
let frequencyData = null;
let animationFrame = 0;
let canvasMetrics = null;
let toastTimer = 0;
let stopping = false;
let visualizationIndex = requestedVisualizationIndex >= 0 ? requestedVisualizationIndex : 0;
let bassHistory = [];
let fluxHistory = [];
let beatIntervals = [];

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const average = (values, start = 0, end = values.length) => {
  let total = 0;
  for (let index = start; index < end; index += 1) total += values[index];
  return total / Math.max(1, end - start);
};

function showStatus(message, duration = 1800) {
  ui.status.textContent = message;
  ui.status.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.status.classList.remove("show"), duration);
}

function resetFeatureAnalysis() {
  features.bass = 0;
  features.mids = 0;
  features.treble = 0;
  features.energy = 0;
  features.flux = 0;
  features.beatPulse = 0;
  features.beatCount = 0;
  features.bpm = null;
  features.lastBeatAt = -Infinity;
  features.lastFrameAt = 0;
  bassHistory = [];
  fluxHistory = [];
  beatIntervals = [];
  previousSpectrum.fill(0.015);
}

function setWaitingState() {
  document.body.classList.remove("started");
  ui.start.disabled = false;
  ui.startLabel.textContent = "START SYSTEM AUDIO";
}

function setLiveState() {
  document.body.classList.add("started");
}

function describeCaptureError(error) {
  if (error?.name === "NotAllowedError") return "SHARING WAS CANCELLED";
  if (error?.name === "NotFoundError") return "NO CAPTURE SOURCE FOUND";
  if (error?.name === "NotReadableError") return "THE AUDIO SOURCE IS BUSY";
  if (!window.isSecureContext) return "OPEN THIS APP ON LOCALHOST OR HTTPS";
  return "SYSTEM AUDIO COULD NOT START";
}

async function startCapture() {
  if (displayStream) return;

  if (!navigator.mediaDevices?.getDisplayMedia) {
    showStatus("SCREEN AUDIO CAPTURE IS NOT SUPPORTED HERE", 3600);
    return;
  }

  ui.start.disabled = true;
  ui.startLabel.textContent = "CHOOSE A SOURCE…";

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "monitor" },
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        suppressLocalAudioPlayback: false,
      },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      systemAudio: "include",
    });

    const [audioTrack] = stream.getAudioTracks();
    if (!audioTrack) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("The selected source did not include audio.", "NoAudioTrackError");
    }

    displayStream = stream;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: "interactive" });
    await audioContext.resume();

    sourceNode = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;
    sourceNode.connect(analyser);

    frequencyData = new Float32Array(analyser.frequencyBinCount);
    stopping = false;
    resetFeatureAnalysis();

    // Display capture requires a video track. It remains alive to preserve the
    // permission session, but the application never renders or stores it.
    stream.getVideoTracks().forEach((track) => { track.enabled = false; });
    stream.getTracks().forEach((track) => track.addEventListener("ended", handleCaptureEnded, { once: true }));

    setLiveState();
    showStatus("SYSTEM AUDIO LIVE");
  } catch (error) {
    console.error(error);
    await releaseCapture();
    ui.start.disabled = false;
    ui.startLabel.textContent = "TRY AGAIN";

    if (error?.name === "NoAudioTrackError") {
      showStatus("ENABLE ‘SHARE SYSTEM AUDIO’ AND TRY AGAIN", 4200);
    } else {
      showStatus(describeCaptureError(error), 3200);
    }
  }
}

async function releaseCapture() {
  const stream = displayStream;
  displayStream = null;

  if (stream) stream.getTracks().forEach((track) => track.stop());
  sourceNode?.disconnect();
  sourceNode = null;
  analyser = null;
  frequencyData = null;

  if (audioContext && audioContext.state !== "closed") {
    await audioContext.close().catch(() => {});
  }
  audioContext = null;
}

async function stopCapture({ notify = true } = {}) {
  if (stopping) return;
  stopping = true;
  await releaseCapture();
  resetFeatureAnalysis();
  setWaitingState();
  stopping = false;
  if (notify) showStatus("CAPTURE STOPPED");
}

function handleCaptureEnded() {
  if (!displayStream || stopping) return;
  stopCapture({ notify: true });
}

function getSpectrumBands() {
  if (!analyser || !frequencyData || !audioContext) return idleSpectrum;

  analyser.getFloatFrequencyData(frequencyData);
  const bands = new Float32Array(bandCount);
  const nyquist = audioContext.sampleRate / 2;
  const minimumFrequency = 35;
  const maximumFrequency = Math.min(16000, nyquist);

  for (let index = 0; index < bands.length; index += 1) {
    const lowerRatio = index / bands.length;
    const upperRatio = (index + 1) / bands.length;
    const lowFrequency = minimumFrequency * ((maximumFrequency / minimumFrequency) ** lowerRatio);
    const highFrequency = minimumFrequency * ((maximumFrequency / minimumFrequency) ** upperRatio);
    const lowBin = clamp(Math.floor((lowFrequency / nyquist) * frequencyData.length), 0, frequencyData.length - 1);
    const highBin = clamp(Math.ceil((highFrequency / nyquist) * frequencyData.length), lowBin + 1, frequencyData.length);

    let energy = 0;
    for (let bin = lowBin; bin < highBin; bin += 1) {
      const decibels = Number.isFinite(frequencyData[bin]) ? frequencyData[bin] : -100;
      energy += clamp((decibels + 100) / 80, 0, 1);
    }

    const bandAverage = energy / Math.max(1, highBin - lowBin);
    bands[index] = clamp(bandAverage ** 1.35, 0.015, 1);
  }

  return bands;
}

function historyStats(history) {
  if (!history.length) return { mean: 0, deviation: 0 };
  const mean = average(history);
  let variance = 0;
  for (const value of history) variance += (value - mean) ** 2;
  return { mean, deviation: Math.sqrt(variance / history.length) };
}

function updateAudioFeatures(bands, timestamp) {
  const delta = features.lastFrameAt ? Math.min(100, timestamp - features.lastFrameAt) : 16;
  features.lastFrameAt = timestamp;

  const targetBass = average(bands, 0, 7);
  const targetMids = average(bands, 7, 16);
  const targetTreble = average(bands, 16, 24);
  const targetEnergy = average(bands);

  features.bass += (targetBass - features.bass) * .28;
  features.mids += (targetMids - features.mids) * .22;
  features.treble += (targetTreble - features.treble) * .25;
  features.energy += (targetEnergy - features.energy) * .2;

  let flux = 0;
  for (let index = 0; index < bands.length; index += 1) {
    flux += Math.max(0, bands[index] - previousSpectrum[index]);
    previousSpectrum[index] = bands[index];
  }
  flux /= bands.length;
  features.flux = flux;

  if (analyser) {
    const bassStats = historyStats(bassHistory);
    const fluxStats = historyStats(fluxHistory);
    const bassOnset = targetBass > bassStats.mean + Math.max(.018, bassStats.deviation * 1.25);
    const spectralOnset = flux > fluxStats.mean + Math.max(.008, fluxStats.deviation * 1.5);
    const enoughSignal = targetEnergy > .035;
    const refractoryPeriodPassed = timestamp - features.lastBeatAt > 270;

    if (bassHistory.length > 18 && enoughSignal && refractoryPeriodPassed && bassOnset && spectralOnset) {
      registerBeat(timestamp);
    }

    bassHistory.push(targetBass);
    fluxHistory.push(flux);
    if (bassHistory.length > 72) bassHistory.shift();
    if (fluxHistory.length > 72) fluxHistory.shift();
  }

  features.beatPulse = Math.max(0, features.beatPulse - delta / 360);
}

function registerBeat(timestamp) {
  const interval = timestamp - features.lastBeatAt;
  features.lastBeatAt = timestamp;
  features.beatPulse = 1;
  features.beatCount += 1;

  if (Number.isFinite(interval) && interval >= 270 && interval <= 1600) {
    let normalizedInterval = interval;
    while (normalizedInterval < 333) normalizedInterval *= 2;
    while (normalizedInterval > 1000) normalizedInterval /= 2;
    beatIntervals.push(normalizedInterval);
    if (beatIntervals.length > 12) beatIntervals.shift();

    if (beatIntervals.length >= 3) {
      const sorted = [...beatIntervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const measuredBpm = Math.round(60000 / median);
      features.bpm = features.bpm
        ? Math.round(features.bpm * .72 + measuredBpm * .28)
        : measuredBpm;
    }
  }
}

function visualizationCenter(width, height) {
  return {
    x: width / 2,
    y: height / 2,
  };
}

function drawMirroredSpectrum({ context, width, height, bands }) {
  const count = bands.length;
  const gap = width < 600 ? 3 : 5;
  const usableWidth = width * .72;
  const barWidth = Math.max(2, (usableWidth - gap * count) / count);
  const startX = (width - usableWidth) / 2;
  const pulseScale = 1 + features.beatPulse * .16;

  context.save();
  context.translate(0, height / 2);
  context.fillStyle = `rgba(216, 255, 62, ${.42 + features.energy * .25})`;
  context.shadowColor = "rgba(216, 255, 62, .28)";
  context.shadowBlur = features.beatPulse * 14;

  for (let index = 0; index < count; index += 1) {
    const frequencyEmphasis = index < 7 ? 1 + features.bass * .35 : 1;
    const barHeight = bands[index] * height * .42 * pulseScale * frequencyEmphasis;
    context.fillRect(startX + index * (barWidth + gap), -barHeight, barWidth, barHeight * 2);
  }

  context.restore();
}

function drawPrismaticVortex({ context, width, height, bands, timestamp }) {
  const center = visualizationCenter(width, height);
  const size = Math.min(width, height);
  const drive = analyser ? features.energy : .09 + Math.sin(timestamp * .0012) * .02;
  const bass = analyser ? features.bass : .08;
  const mids = analyser ? features.mids : .07;
  const treble = analyser ? features.treble : .06;
  const tempoRate = features.bpm ? features.bpm / 120 : 1;
  const rotation = timestamp * .00018 * tempoRate;
  const coreRadius = size * (.045 + bass * .055 + features.beatPulse * .018);

  context.save();
  context.globalCompositeOperation = "lighter";

  const glow = context.createRadialGradient(center.x, center.y, 0, center.x, center.y, size * .4);
  glow.addColorStop(0, `rgba(255, 170, 42, ${.1 + drive * .25})`);
  glow.addColorStop(.35, `rgba(153, 54, 255, ${.055 + mids * .14})`);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  for (let strand = 0; strand < 8; strand += 1) {
    context.beginPath();
    for (let step = 0; step <= 90; step += 1) {
      const progress = step / 90;
      const band = bands[(step + strand * 3) % bands.length];
      const angle = progress * Math.PI * (4.5 + mids * 2.5) + rotation + strand * .72;
      const wobble = Math.sin(progress * Math.PI * 9 + timestamp * .0011 + strand) * size * (.008 + band * .035);
      const radius = coreRadius + progress * size * (.28 + bass * .14) + wobble;
      const x = center.x + Math.cos(angle) * radius;
      const y = center.y + Math.sin(angle) * radius * (.6 + treble * .18);
      if (step === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    const hue = (28 + strand * 38 + timestamp * .012) % 360;
    context.strokeStyle = `hsla(${hue}, 92%, 62%, ${.13 + drive * .34})`;
    context.lineWidth = .7 + mids * 2.8 + (strand % 3 === 0 ? features.beatPulse * 1.4 : 0);
    context.shadowColor = `hsla(${hue}, 95%, 60%, .55)`;
    context.shadowBlur = 5 + features.beatPulse * 13;
    context.stroke();
  }

  const particleCount = 42 + Math.round(treble * 46);
  for (let index = 0; index < particleCount; index += 1) {
    const seed = index * 12.9898;
    const orbit = size * (.09 + ((Math.sin(seed) + 1) * .5) * .34);
    const angle = rotation * (1.3 + (index % 5) * .08) + index * 2.399;
    const x = center.x + Math.cos(angle) * orbit;
    const y = center.y + Math.sin(angle) * orbit * .64;
    const radius = .45 + bands[index % bands.length] * 2.8 + features.beatPulse * .45;
    context.fillStyle = `hsla(${(index * 29 + timestamp * .018) % 360}, 95%, 72%, ${.18 + treble * .5})`;
    context.fillRect(x, y, radius, radius);
  }

  context.globalCompositeOperation = "source-over";
  const core = context.createRadialGradient(center.x - coreRadius * .2, center.y - coreRadius * .2, 0, center.x, center.y, coreRadius * 1.35);
  core.addColorStop(0, "rgba(18, 14, 25, .92)");
  core.addColorStop(.72, "rgba(4, 4, 7, .97)");
  core.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = core;
  context.beginPath();
  context.arc(center.x, center.y, coreRadius * 1.35, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawStellarBloom({ context, width, height, bands, timestamp }) {
  const center = visualizationCenter(width, height);
  const size = Math.min(width, height);
  const bass = analyser ? features.bass : .07;
  const mids = analyser ? features.mids : .06;
  const treble = analyser ? features.treble : .05;
  const tempoRate = features.bpm ? features.bpm / 120 : 1;
  const rotation = timestamp * .00011 * tempoRate;
  const innerRadius = size * (.045 + features.beatPulse * .035);

  context.save();
  context.translate(center.x, center.y);
  context.rotate(rotation);
  context.globalCompositeOperation = "lighter";

  for (let ring = 0; ring < 4; ring += 1) {
    const radius = size * (.1 + ring * .075 + bass * .07) + features.beatPulse * ring * 4;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.strokeStyle = `hsla(${190 + ring * 48}, 90%, 65%, ${.035 + mids * .13})`;
    context.lineWidth = .6 + features.beatPulse * .7;
    context.stroke();
  }

  const rayCount = 72;
  for (let index = 0; index < rayCount; index += 1) {
    const angle = (index / rayCount) * Math.PI * 2;
    const band = bands[index % bands.length];
    const groupBoost = index % 3 === 0 ? bass : index % 3 === 1 ? mids : treble;
    const rayLength = size * (.07 + band * .3 + groupBoost * .11 + features.beatPulse * .045);
    const inner = innerRadius + Math.sin(index * 1.7 + timestamp * .0015) * size * .008;
    const x1 = Math.cos(angle) * inner;
    const y1 = Math.sin(angle) * inner;
    const x2 = Math.cos(angle) * (inner + rayLength);
    const y2 = Math.sin(angle) * (inner + rayLength);
    const hue = (188 + index * 3.9 + timestamp * .01) % 360;

    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.strokeStyle = `hsla(${hue}, 92%, 66%, ${.08 + band * .44})`;
    context.lineWidth = .45 + band * 1.5;
    context.shadowColor = `hsla(${hue}, 100%, 64%, .45)`;
    context.shadowBlur = features.beatPulse * 9;
    context.stroke();

    if (index % 2 === 0) {
      const particleRadius = .4 + treble * 2.5 + (index % 6 === 0 ? features.beatPulse * 1.4 : 0);
      context.fillStyle = `hsla(${hue + 35}, 100%, 78%, ${.16 + treble * .5})`;
      context.beginPath();
      context.arc(x2, y2, particleRadius, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.globalCompositeOperation = "source-over";
  context.fillStyle = "rgba(5, 5, 8, .92)";
  context.beginPath();
  context.arc(0, 0, innerRadius * .76, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function setVisualization(nextIndex, announce = true) {
  visualizationIndex = (nextIndex + visualizations.length) % visualizations.length;
  const visualization = visualizations[visualizationIndex];
  const url = new URL(window.location.href);
  url.searchParams.set("visualization", visualization.id);
  window.history.replaceState(window.history.state, "", url);
  document.title = `Visualization ${visualization.id}`;
  ui.canvas.setAttribute("aria-label", `Live system-audio visualization ${visualization.id}`);
  if (announce) showStatus(visualization.id);
}

function draw(timestamp = 0) {
  const canvas = ui.canvas;
  if (!canvasMetrics) {
    const bounds = canvas.getBoundingClientRect();
    canvasMetrics = {
      width: bounds.width,
      height: bounds.height,
      dpr: Math.min(window.devicePixelRatio || 1, 1.5),
    };
  }

  const { width, height, dpr } = canvasMetrics;
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  canvasContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvasContext.clearRect(0, 0, width, height);

  const bands = getSpectrumBands();
  updateAudioFeatures(bands, timestamp);
  visualizations[visualizationIndex].draw({
    context: canvasContext,
    width,
    height,
    bands,
    timestamp,
  });
  animationFrame = requestAnimationFrame(draw);
}

ui.start.addEventListener("click", startCapture);

document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setVisualization(visualizationIndex - 1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setVisualization(visualizationIndex + 1);
  }
});

new ResizeObserver(() => {
  canvasMetrics = null;
}).observe(ui.canvas);

document.addEventListener("visibilitychange", () => {
  if (!audioContext || document.hidden) return;
  audioContext.resume().catch(() => {});
});

window.addEventListener("beforeunload", () => {
  displayStream?.getTracks().forEach((track) => track.stop());
});

setWaitingState();
setVisualization(visualizationIndex, false);
animationFrame = requestAnimationFrame(draw);
