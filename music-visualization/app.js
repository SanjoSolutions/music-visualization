const $ = (selector) => document.querySelector(selector);

const ui = {
  canvas: $("#visualizer"),
  start: $("#startButton"),
  stop: $("#stopButton"),
  startLabel: $("#startButton b"),
  source: $("#sourceName"),
  level: $("#level"),
  format: $("#format"),
  elapsed: $("#elapsed"),
  fill: $("#timelineFill"),
  meter: $(".timeline"),
  signalState: $("#signalState"),
  indicator: $("#liveIndicator"),
  liveLabel: $("#liveLabel"),
  hint: $("#permissionHint"),
  toast: $("#toast"),
};

const canvasContext = ui.canvas.getContext("2d", { alpha: true });
const idleSpectrum = new Float32Array(24).fill(0.015);

let displayStream = null;
let audioContext = null;
let sourceNode = null;
let analyser = null;
let frequencyData = null;
let timeData = null;
let animationFrame = 0;
let startedAt = 0;
let lastReadoutUpdate = 0;
let canvasMetrics = null;
let toastTimer = 0;
let stopping = false;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function showToast(message, duration = 2400) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove("show"), duration);
}

function setWaitingState() {
  document.body.classList.remove("started");
  ui.indicator.classList.remove("is-live");
  ui.liveLabel.textContent = "AWAITING SIGNAL";
  ui.start.disabled = false;
  ui.startLabel.textContent = "SHARE SYSTEM AUDIO";
  ui.stop.hidden = true;
  ui.hint.textContent = "Your browser will ask what to share. Video is never displayed or stored.";
  ui.fill.style.width = "0%";
  ui.meter.setAttribute("aria-valuenow", "0");
}

function setLiveState(track) {
  const settings = track.getSettings?.() ?? {};
  const sampleRate = settings.sampleRate || audioContext.sampleRate;
  const channels = settings.channelCount;

  document.body.classList.add("started");
  ui.indicator.classList.add("is-live");
  ui.liveLabel.textContent = "SYSTEM AUDIO LIVE";
  ui.source.textContent = track.label || "Shared system audio";
  ui.format.textContent = `${Math.round(sampleRate / 1000)} kHz${channels ? ` · ${channels}CH` : ""}`;
  ui.stop.hidden = false;
  ui.hint.textContent = "Listening locally. Nothing is uploaded or recorded.";
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
    showToast("SCREEN AUDIO CAPTURE IS NOT SUPPORTED HERE", 3600);
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

    const audioOnlyStream = new MediaStream([audioTrack]);
    sourceNode = audioContext.createMediaStreamSource(audioOnlyStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;
    sourceNode.connect(analyser);

    frequencyData = new Float32Array(analyser.frequencyBinCount);
    timeData = new Float32Array(analyser.fftSize);
    startedAt = performance.now();
    lastReadoutUpdate = 0;
    stopping = false;

    // The browser requires a video track for display capture. Keep the track
    // alive so the permission session remains active, but never render it.
    stream.getVideoTracks().forEach((track) => { track.enabled = false; });
    stream.getTracks().forEach((track) => track.addEventListener("ended", handleCaptureEnded, { once: true }));

    setLiveState(audioTrack);
    showToast("SYSTEM AUDIO LIVE");
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(draw);

    window.setTimeout(() => $("#console").scrollIntoView({ behavior: "smooth", block: "end" }), 350);
  } catch (error) {
    console.error(error);
    await releaseCapture();
    ui.start.disabled = false;
    ui.startLabel.textContent = "TRY AGAIN";

    if (error?.name === "NoAudioTrackError") {
      showToast("ENABLE ‘SHARE SYSTEM AUDIO’ AND TRY AGAIN", 4200);
      ui.hint.textContent = "No audio was included. Choose Entire Screen and enable Share system audio.";
    } else {
      showToast(describeCaptureError(error), 3200);
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
  timeData = null;

  if (audioContext && audioContext.state !== "closed") {
    await audioContext.close().catch(() => {});
  }
  audioContext = null;
}

async function stopCapture({ notify = true } = {}) {
  if (stopping) return;
  stopping = true;
  await releaseCapture();
  setWaitingState();
  stopping = false;
  if (notify) showToast("CAPTURE STOPPED");
  cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame(draw);
}

function handleCaptureEnded() {
  if (!displayStream || stopping) return;
  stopCapture({ notify: true });
}

function getSpectrumBands() {
  if (!analyser || !frequencyData || !audioContext) return idleSpectrum;

  analyser.getFloatFrequencyData(frequencyData);
  const bands = new Float32Array(24);
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

    const average = energy / Math.max(1, highBin - lowBin);
    // A gentle curve keeps quiet details visible without flattening loud hits.
    bands[index] = clamp(average ** 1.35, 0.015, 1);
  }

  return bands;
}

function getSignalLevel() {
  if (!analyser || !timeData) return { decibels: -Infinity, percent: 0 };

  analyser.getFloatTimeDomainData(timeData);
  let sumOfSquares = 0;
  for (const sample of timeData) sumOfSquares += sample * sample;
  const rms = Math.sqrt(sumOfSquares / timeData.length);
  const decibels = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const percent = clamp(((decibels + 60) / 54) * 100, 0, 100);
  return { decibels, percent };
}

function updateReadouts(timestamp) {
  if (!displayStream || timestamp - lastReadoutUpdate < 100) return;
  lastReadoutUpdate = timestamp;

  const { decibels, percent } = getSignalLevel();
  ui.level.innerHTML = Number.isFinite(decibels)
    ? `${Math.round(decibels)} <small>dB</small>`
    : `−∞ <small>dB</small>`;
  ui.elapsed.textContent = formatElapsed(timestamp - startedAt);
  ui.fill.style.width = `${percent.toFixed(1)}%`;
  ui.meter.setAttribute("aria-valuenow", String(Math.round(percent)));
  ui.signalState.textContent = percent < 2 ? "WAITING FOR SOUND" : percent > 88 ? "PEAK" : "SIGNAL ACTIVE";
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
  const count = bands.length;
  const gap = width < 600 ? 3 : 5;
  const usableWidth = width * (width < 600 ? .72 : .48);
  const barWidth = Math.max(2, (usableWidth - gap * count) / count);
  const startX = width * (width < 600 ? .35 : .56);

  canvasContext.save();
  canvasContext.translate(0, height / 2);
  canvasContext.fillStyle = "rgba(216, 255, 62, .48)";

  for (let index = 0; index < count; index += 1) {
    const barHeight = bands[index] * height * .34;
    canvasContext.fillRect(startX + index * (barWidth + gap), -barHeight, barWidth, barHeight * 2);
  }

  canvasContext.restore();
  updateReadouts(timestamp);
  animationFrame = requestAnimationFrame(draw);
}

ui.start.addEventListener("click", startCapture);
ui.stop.addEventListener("click", () => stopCapture());

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
animationFrame = requestAnimationFrame(draw);
