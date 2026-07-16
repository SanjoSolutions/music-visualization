import { AudioStreamAnalyzer } from "./packages/music-audio-features/src/index.js";

const $ = (selector) => document.querySelector(selector);

const ui = {
  canvas: $("#visualizer"),
  start: $("#startButton"),
  startLabel: $("#startButton strong"),
  status: $("#status"),
};

const canvasContext = ui.canvas.getContext("2d", { alpha: false, desynchronized: true });
const bandCount = 24;
const analysisFftSize = 2048;
const audioAnalyzer = new AudioStreamAnalyzer({ bandCount, fftSize: analysisFftSize });
const audioFrame = audioAnalyzer.sample(0);
const sourceFeatures = audioFrame.features;
const features = { ...sourceFeatures };
const responsiveSpectrum = new Float32Array(bandCount).fill(0.015);
const MINIMUM_BAND_CHANGE = 0.045;
const MINIMUM_FEATURE_CHANGE = 0.035;

const visualizations = [
  { id: "1", draw: drawMirroredSpectrum },
  { id: "2", draw: drawPrismaticVortex },
  { id: "3", draw: drawStellarBloom },
];

const requestedVisualization = new URL(window.location.href).searchParams.get("visualization");
const requestedVisualizationIndex = visualizations.findIndex(({ id }) => id === requestedVisualization);

let displayStream = null;
let captureActive = false;
let nativeCaptureActive = false;
let nativeDiagnostics = null;
let removeNativeFrameListener = null;
let removeNativeEndedListener = null;
let animationFrame = 0;
let canvasMetrics = null;
let toastTimer = 0;
let stopping = false;
let visualizationIndex = requestedVisualizationIndex >= 0 ? requestedVisualizationIndex : 0;
let averageFrameInterval = 0;
let previousAnimationTimestamp = 0;

const renderingDiagnostics = {
  canvasDesynchronized: Boolean(canvasContext.getContextAttributes?.().desynchronized),
};

ui.canvas.dataset.causal = "true";
ui.canvas.dataset.desynchronized = String(renderingDiagnostics.canvasDesynchronized);
ui.canvas.dataset.fftSize = String(analysisFftSize);
ui.canvas.dataset.analyserSmoothing = "0";

Object.defineProperty(window, "__visualizerDiagnostics", {
  value: () => ({
    ...audioAnalyzer.diagnostics,
    ...nativeDiagnostics,
    ...renderingDiagnostics,
    spectrumBands: Array.from(audioFrame.bands),
    audioFrameTimestamp: audioFrame.timestamp,
    averageFrameIntervalMilliseconds: averageFrameInterval || null,
  }),
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
function showStatus(message, duration = 1800) {
  ui.status.textContent = message;
  ui.status.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.status.classList.remove("show"), duration);
}

function resetFeatureAnalysis() {
  audioAnalyzer.reset();
  responsiveSpectrum.fill(0.015);
  Object.assign(features, sourceFeatures);
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
  if (captureActive) return;

  if (!window.systemAudio && !navigator.mediaDevices?.getDisplayMedia) {
    showStatus("SCREEN AUDIO CAPTURE IS NOT SUPPORTED HERE", 3600);
    return;
  }

  ui.start.disabled = true;
  ui.startLabel.textContent = window.systemAudio ? "STARTING AUDIO…" : "CHOOSE A SOURCE…";

  try {
    let diagnostics;
    if (window.systemAudio) {
      diagnostics = await startNativeCapture();
      nativeCaptureActive = true;
    } else {
      const stream = await startBrowserCapture();
      displayStream = stream;
      await audioAnalyzer.connect(stream);
      diagnostics = audioAnalyzer.diagnostics;
      stream.getTracks().forEach((track) => track.addEventListener("ended", handleCaptureEnded, { once: true }));
    }
    captureActive = true;
    ui.canvas.dataset.sampleRate = String(diagnostics.sampleRate);
    ui.canvas.dataset.fftWindowMilliseconds = diagnostics.fftWindowMilliseconds.toFixed(3);
    if (diagnostics.hopSize) ui.canvas.dataset.analysisHopSize = String(diagnostics.hopSize);
    stopping = false;
    resetFeatureAnalysis();

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

async function startBrowserCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "monitor" },
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        latency: { ideal: 0 },
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

  // Browsers require this permission track; the Electron path never creates it.
  stream.getVideoTracks().forEach((track) => { track.enabled = false; });
  return stream;
}

async function startNativeCapture() {
  removeNativeFrameListener = window.systemAudio.onFrame((frame) => {
    audioFrame.active = frame.active;
    audioFrame.timestamp = frame.timestamp;
    audioFrame.bands.set(frame.bands);
    Object.assign(sourceFeatures, frame.features);
  });
  removeNativeEndedListener = window.systemAudio.onEnded((message) => {
    if (message) console.error(message);
    handleCaptureEnded();
  });

  nativeDiagnostics = await window.systemAudio.start();
  return nativeDiagnostics;
}

async function releaseCapture() {
  const stream = displayStream;
  displayStream = null;
  captureActive = false;
  nativeCaptureActive = false;
  nativeDiagnostics = null;

  if (stream) stream.getTracks().forEach((track) => track.stop());
  removeNativeFrameListener?.();
  removeNativeEndedListener?.();
  removeNativeFrameListener = null;
  removeNativeEndedListener = null;
  if (window.systemAudio) await window.systemAudio.stop().catch(() => {});
  await audioAnalyzer.disconnect();
  delete ui.canvas.dataset.sampleRate;
  delete ui.canvas.dataset.fftWindowMilliseconds;
  delete ui.canvas.dataset.analysisHopSize;
}

if (window.systemAudio) {
  ui.start.querySelector("span").textContent = "Direct audio capture — no screen sharing";
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
  if (!captureActive || stopping) return;
  stopCapture({ notify: true });
}

function visualizationCenter(width, height) {
  return {
    x: width / 2,
    y: height / 2,
  };
}

function stabilizeAudioResponse(bands) {
  for (let index = 0; index < bands.length; index += 1) {
    const left = bands[Math.max(0, index - 1)];
    const center = bands[index];
    const right = bands[Math.min(bands.length - 1, index + 1)];
    const spatialAverage = (left + center * 2 + right) / 4;
    const target = spatialAverage < .06
      ? .015
      : clamp((spatialAverage - .035) * 1.08, .015, 1);
    const difference = target - responsiveSpectrum[index];

    // A shared dead zone keeps every visualization still through minor audio
    // fluctuations. Larger changes remain quick, while releases are gentler.
    if (Math.abs(difference) < MINIMUM_BAND_CHANGE) continue;
    const response = difference > .12 ? .62 : difference > 0 ? .28 : .08;
    responsiveSpectrum[index] += difference * response;
  }

  for (const key of ["bass", "mids", "treble", "energy"]) {
    const difference = sourceFeatures[key] - features[key];
    if (Math.abs(difference) < MINIMUM_FEATURE_CHANGE) continue;
    features[key] += difference * (difference > 0 ? .45 : .12);
  }

  // Onset pulses are already thresholded events, so preserve their immediacy.
  features.flux = sourceFeatures.flux;
  features.beatPulse = sourceFeatures.beatPulse;
  features.kickPulse = sourceFeatures.kickPulse;
  features.beatCount = sourceFeatures.beatCount;
  features.bpm = sourceFeatures.bpm;

  return responsiveSpectrum;
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
  const drive = audioFrame.active ? features.energy : .09 + Math.sin(timestamp * .0012) * .02;
  const bass = audioFrame.active ? features.bass : .08;
  const mids = audioFrame.active ? features.mids : .07;
  const treble = audioFrame.active ? features.treble : .06;
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
  const bass = audioFrame.active ? features.bass : .07;
  const mids = audioFrame.active ? features.mids : .06;
  const treble = audioFrame.active ? features.treble : .05;
  const tempoRate = features.bpm ? features.bpm / 120 : 1;
  const rotation = timestamp * .00011 * tempoRate;
  const kickEnvelope = features.kickPulse ** .55;
  const innerRadius = size * (.04 + kickEnvelope * .085);

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
  context.arc(0, 0, innerRadius * (.76 + kickEnvelope * .16), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function setVisualization(nextIndex) {
  visualizationIndex = (nextIndex + visualizations.length) % visualizations.length;
  const visualization = visualizations[visualizationIndex];
  const url = new URL(window.location.href);
  url.searchParams.set("visualization", visualization.id);
  window.history.replaceState(window.history.state, "", url);
  document.title = `Visualization ${visualization.id}`;
  ui.canvas.dataset.visualization = visualization.id;
  ui.canvas.setAttribute("aria-label", `Live system-audio visualization ${visualization.id}`);
}

function draw(timestamp = 0) {
  if (timestamp && previousAnimationTimestamp) {
    const frameInterval = timestamp - previousAnimationTimestamp;
    averageFrameInterval = averageFrameInterval
      ? averageFrameInterval * .92 + frameInterval * .08
      : frameInterval;
  }
  if (timestamp) previousAnimationTimestamp = timestamp;

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
  canvasContext.globalCompositeOperation = "copy";
  canvasContext.fillStyle = "#070708";
  canvasContext.fillRect(0, 0, width, height);
  canvasContext.globalCompositeOperation = "source-over";

  const { bands: sourceBands } = nativeCaptureActive ? audioFrame : audioAnalyzer.sample(timestamp);
  const bands = stabilizeAudioResponse(sourceBands);
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
  if (nativeCaptureActive || !audioAnalyzer.connected || document.hidden) return;
  audioAnalyzer.resume().catch(() => {});
});

window.addEventListener("beforeunload", () => {
  displayStream?.getTracks().forEach((track) => track.stop());
  if (window.systemAudio) void window.systemAudio.stop();
  void audioAnalyzer.disconnect();
});

setWaitingState();
setVisualization(visualizationIndex);
animationFrame = requestAnimationFrame(draw);
