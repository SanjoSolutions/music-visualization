const DEFAULT_BAND_VALUE = 0.015;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const average = (values, start = 0, end = values.length) => {
  let total = 0;
  for (let index = start; index < end; index += 1) total += values[index];
  return total / Math.max(1, end - start);
};

const historyStats = (history) => {
  if (!history.length) return { mean: 0, deviation: 0 };
  const mean = average(history);
  let variance = 0;
  for (const value of history) variance += (value - mean) ** 2;
  return { mean, deviation: Math.sqrt(variance / history.length) };
};

const followEnvelope = (current, target) => {
  const response = target > current ? 0.72 : 0.24;
  return current + (target - current) * response;
};

const createFeatures = () => ({
  bass: 0,
  mids: 0,
  treble: 0,
  energy: 0,
  flux: 0,
  beatPulse: 0,
  kickPulse: 0,
  beatCount: 0,
  bpm: null,
});

/**
 * Turns normalized spectrum bands into stable, causal music features.
 * The returned frame and its typed array are reused on every update.
 */
export class AudioFeatureExtractor {
  constructor({ bandCount = 24 } = {}) {
    if (!Number.isInteger(bandCount) || bandCount < 3) {
      throw new RangeError("bandCount must be an integer of at least 3.");
    }

    this.bandCount = bandCount;
    this.bands = new Float32Array(bandCount).fill(DEFAULT_BAND_VALUE);
    this.features = createFeatures();
    this.frame = {
      active: false,
      timestamp: 0,
      bands: this.bands,
      features: this.features,
    };
    this.previousSpectrum = new Float32Array(bandCount).fill(DEFAULT_BAND_VALUE);
    this.bassHistory = [];
    this.fluxHistory = [];
    this.beatIntervals = [];
    this.lastBeatAt = -Infinity;
    this.lastKickAt = -Infinity;
    this.previousKickEnergy = 0;
    this.lastFrameAt = 0;
  }

  reset() {
    Object.assign(this.features, createFeatures());
    this.frame.active = false;
    this.frame.timestamp = 0;
    this.lastBeatAt = -Infinity;
    this.lastKickAt = -Infinity;
    this.previousKickEnergy = 0;
    this.lastFrameAt = 0;
    this.bassHistory.length = 0;
    this.fluxHistory.length = 0;
    this.beatIntervals.length = 0;
    this.bands.fill(DEFAULT_BAND_VALUE);
    this.previousSpectrum.fill(DEFAULT_BAND_VALUE);
    return this.frame;
  }

  update(inputBands, timestamp, { active = true } = {}) {
    if (!inputBands || inputBands.length !== this.bandCount) {
      throw new RangeError(`Expected ${this.bandCount} spectrum bands.`);
    }

    const time = Number.isFinite(timestamp) ? timestamp : 0;
    const delta = this.lastFrameAt ? clamp(time - this.lastFrameAt, 0, 100) : 16;
    this.lastFrameAt = time;
    this.frame.active = active;
    this.frame.timestamp = time;
    if (inputBands !== this.bands) this.bands.set(inputBands);

    const bassEnd = Math.max(1, Math.round(this.bandCount * 7 / 24));
    const midsEnd = Math.max(bassEnd + 1, Math.round(this.bandCount * 16 / 24));
    const targetBass = average(this.bands, 0, bassEnd);
    const targetMids = average(this.bands, bassEnd, midsEnd);
    const targetTreble = average(this.bands, midsEnd, this.bandCount);
    const targetEnergy = average(this.bands);

    this.features.bass = followEnvelope(this.features.bass, targetBass);
    this.features.mids = followEnvelope(this.features.mids, targetMids);
    this.features.treble = followEnvelope(this.features.treble, targetTreble);
    this.features.energy = followEnvelope(this.features.energy, targetEnergy);

    let flux = 0;
    let lowFrequencyFlux = 0;
    for (let index = 0; index < this.bandCount; index += 1) {
      const increase = Math.max(0, this.bands[index] - this.previousSpectrum[index]);
      flux += increase;
      if (index < bassEnd) lowFrequencyFlux += increase;
      this.previousSpectrum[index] = this.bands[index];
    }
    flux /= this.bandCount;
    lowFrequencyFlux /= bassEnd;
    this.features.flux = flux;

    if (active) {
      this.#detectOnsets({ targetBass, targetEnergy, flux, lowFrequencyFlux, timestamp: time });
      this.previousKickEnergy = targetBass;
      this.bassHistory.push(targetBass);
      this.fluxHistory.push(flux);
      if (this.bassHistory.length > 72) this.bassHistory.shift();
      if (this.fluxHistory.length > 72) this.fluxHistory.shift();
    }

    this.features.beatPulse = Math.max(0, this.features.beatPulse - delta / 360);
    this.features.kickPulse = Math.max(0, this.features.kickPulse - delta / 220);
    return this.frame;
  }

  #detectOnsets({ targetBass, targetEnergy, flux, lowFrequencyFlux, timestamp }) {
    const bassStats = historyStats(this.bassHistory);
    const fluxStats = historyStats(this.fluxHistory);
    const bassOnset = targetBass > bassStats.mean + Math.max(0.018, bassStats.deviation * 1.25);
    const spectralOnset = flux > fluxStats.mean + Math.max(0.008, fluxStats.deviation * 1.5);
    const kickRise = targetBass - this.previousKickEnergy;
    const kickThreshold = bassStats.mean + Math.max(0.012, bassStats.deviation * 1.05);
    const kickOnset = targetBass > kickThreshold
      && kickRise > Math.max(0.005, bassStats.deviation * 0.28)
      && lowFrequencyFlux > 0.004;

    if (
      this.bassHistory.length > 14
      && targetBass > 0.04
      && timestamp - this.lastKickAt > 210
      && kickOnset
    ) {
      this.features.kickPulse = 1;
      this.lastKickAt = timestamp;
    }

    if (
      this.bassHistory.length > 18
      && targetEnergy > 0.035
      && timestamp - this.lastBeatAt > 270
      && bassOnset
      && spectralOnset
    ) {
      this.#registerBeat(timestamp);
    }
  }

  #registerBeat(timestamp) {
    const interval = timestamp - this.lastBeatAt;
    this.lastBeatAt = timestamp;
    this.features.beatPulse = 1;
    this.features.beatCount += 1;

    if (!Number.isFinite(interval) || interval < 270 || interval > 1600) return;

    let normalizedInterval = interval;
    while (normalizedInterval < 333) normalizedInterval *= 2;
    while (normalizedInterval > 1000) normalizedInterval /= 2;
    this.beatIntervals.push(normalizedInterval);
    if (this.beatIntervals.length > 12) this.beatIntervals.shift();

    if (this.beatIntervals.length < 3) return;
    const sorted = [...this.beatIntervals].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)];
    const measuredBpm = Math.round(60000 / median);
    this.features.bpm = this.features.bpm
      ? Math.round(this.features.bpm * 0.72 + measuredBpm * 0.28)
      : measuredBpm;
  }
}

/**
 * Low-latency browser MediaStream analyzer. Call sample() from the consumer's
 * render loop; no timers or prediction are used internally.
 */
export class AudioStreamAnalyzer {
  constructor({
    bandCount = 24,
    fftSize = 512,
    minDecibels = -100,
    maxDecibels = -20,
    smoothingTimeConstant = 0,
    minimumFrequency = 45,
    maximumFrequency = 16000,
    latencyHint = 0.001,
    audioContext = null,
  } = {}) {
    if (!Number.isInteger(fftSize) || fftSize < 32 || fftSize > 32768 || (fftSize & (fftSize - 1)) !== 0) {
      throw new RangeError("fftSize must be a power of two between 32 and 32768.");
    }
    if (!(minimumFrequency > 0) || !(maximumFrequency > minimumFrequency)) {
      throw new RangeError("maximumFrequency must be greater than minimumFrequency.");
    }
    if (!(minDecibels < maxDecibels)) {
      throw new RangeError("maxDecibels must be greater than minDecibels.");
    }
    if (smoothingTimeConstant < 0 || smoothingTimeConstant > 1) {
      throw new RangeError("smoothingTimeConstant must be between 0 and 1.");
    }

    this.options = {
      bandCount,
      fftSize,
      minDecibels,
      maxDecibels,
      smoothingTimeConstant,
      minimumFrequency,
      maximumFrequency,
      latencyHint,
    };
    this.extractor = new AudioFeatureExtractor({ bandCount });
    this.idleBands = new Float32Array(bandCount).fill(DEFAULT_BAND_VALUE);
    this.spectrumBands = this.extractor.bands;
    this.context = audioContext;
    this.ownsContext = !audioContext;
    this.sourceNode = null;
    this.analyserNode = null;
    this.frequencyData = null;
    this.track = null;
    this.trackLatencyMilliseconds = null;
  }

  get connected() {
    return Boolean(this.analyserNode && this.context && this.context.state !== "closed");
  }

  get diagnostics() {
    const sampleRate = this.context?.sampleRate ?? null;
    return {
      causal: true,
      connected: this.connected,
      captureLatencyMilliseconds: this.trackLatencyMilliseconds,
      contextBaseLatencyMilliseconds: Number.isFinite(this.context?.baseLatency)
        ? this.context.baseLatency * 1000
        : null,
      sampleRate,
      fftSize: this.options.fftSize,
      fftWindowMilliseconds: sampleRate ? this.options.fftSize / sampleRate * 1000 : null,
      analyserSmoothing: this.options.smoothingTimeConstant,
      bandCount: this.options.bandCount,
    };
  }

  async connect(input) {
    if (this.connected) await this.disconnect();

    const track = resolveAudioTrack(input);
    const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
    if ("contentHint" in track) track.contentHint = "music";

    let context = this.context;
    if (!context || context.state === "closed") {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio is not supported in this environment.");
      const contextOptions = { latencyHint: this.options.latencyHint };
      if (Number.isFinite(settings.sampleRate)) contextOptions.sampleRate = settings.sampleRate;
      context = new AudioContextClass(contextOptions);
      this.context = context;
      this.ownsContext = true;
    }

    try {
      if (context.state === "suspended") await context.resume();
      const stream = typeof input?.getAudioTracks === "function"
        ? input
        : new globalThis.MediaStream([track]);
      const sourceNode = context.createMediaStreamSource(stream);
      const analyserNode = context.createAnalyser();
      analyserNode.fftSize = this.options.fftSize;
      analyserNode.smoothingTimeConstant = this.options.smoothingTimeConstant;
      analyserNode.minDecibels = this.options.minDecibels;
      analyserNode.maxDecibels = this.options.maxDecibels;
      sourceNode.connect(analyserNode);

      this.track = track;
      this.sourceNode = sourceNode;
      this.analyserNode = analyserNode;
      this.frequencyData = new Float32Array(analyserNode.frequencyBinCount);
      this.trackLatencyMilliseconds = Number.isFinite(settings.latency) ? settings.latency * 1000 : null;
      this.extractor.reset();
      return this;
    } catch (error) {
      if (this.ownsContext && context.state !== "closed") await context.close().catch(() => {});
      this.context = null;
      throw error;
    }
  }

  async resume() {
    if (this.context?.state === "suspended") await this.context.resume();
  }

  sample(timestamp = globalThis.performance?.now?.() ?? 0) {
    if (!this.connected) return this.extractor.update(this.idleBands, timestamp, { active: false });

    this.analyserNode.getFloatFrequencyData(this.frequencyData);
    this.#calculateSpectrumBands();
    return this.extractor.update(this.spectrumBands, timestamp, { active: true });
  }

  reset() {
    this.spectrumBands.fill(DEFAULT_BAND_VALUE);
    return this.extractor.reset();
  }

  async disconnect() {
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.analyserNode = null;
    this.frequencyData = null;
    this.track = null;
    this.trackLatencyMilliseconds = null;

    if (this.ownsContext && this.context?.state !== "closed") {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this.reset();
  }

  #calculateSpectrumBands() {
    const nyquist = this.context.sampleRate / 2;
    const minimumFrequency = Math.max(
      this.options.minimumFrequency,
      this.context.sampleRate / this.analyserNode.fftSize,
    );
    const maximumFrequency = Math.min(this.options.maximumFrequency, nyquist);

    for (let index = 0; index < this.spectrumBands.length; index += 1) {
      const lowerRatio = index / this.spectrumBands.length;
      const upperRatio = (index + 1) / this.spectrumBands.length;
      const lowFrequency = minimumFrequency * ((maximumFrequency / minimumFrequency) ** lowerRatio);
      const highFrequency = minimumFrequency * ((maximumFrequency / minimumFrequency) ** upperRatio);
      const lowBin = clamp(
        Math.floor((lowFrequency / nyquist) * this.frequencyData.length),
        1,
        this.frequencyData.length - 1,
      );
      const highBin = clamp(
        Math.ceil((highFrequency / nyquist) * this.frequencyData.length),
        lowBin + 1,
        this.frequencyData.length,
      );

      let energy = 0;
      for (let bin = lowBin; bin < highBin; bin += 1) {
        const decibels = Number.isFinite(this.frequencyData[bin])
          ? this.frequencyData[bin]
          : this.options.minDecibels;
        energy += clamp(
          (decibels - this.options.minDecibels) / (this.options.maxDecibels - this.options.minDecibels),
          0,
          1,
        );
      }

      const bandAverage = energy / Math.max(1, highBin - lowBin);
      this.spectrumBands[index] = clamp(bandAverage ** 1.35, DEFAULT_BAND_VALUE, 1);
    }
  }
}

function resolveAudioTrack(input) {
  const track = typeof input?.getAudioTracks === "function"
    ? input.getAudioTracks()[0]
    : input;
  if (!track || track.kind !== "audio") {
    throw new TypeError("Expected a MediaStream with audio or an audio MediaStreamTrack.");
  }
  return track;
}
