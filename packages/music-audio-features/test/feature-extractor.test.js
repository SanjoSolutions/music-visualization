import test from "node:test";
import assert from "node:assert/strict";

import { AudioFeatureExtractor, AudioStreamAnalyzer } from "../src/index.js";

const quietBands = () => new Float32Array(24).fill(0.015);

const assertApproximately = (actual, expected, tolerance = 1e-6) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}.`,
  );
};

test("validates analyzer configuration", () => {
  assert.throws(() => new AudioStreamAnalyzer({ fftSize: 500 }), /power of two/);
  assert.throws(() => new AudioStreamAnalyzer({ minDecibels: -20, maxDecibels: -100 }), /maxDecibels/);
  assert.throws(() => new AudioStreamAnalyzer({ smoothingTimeConstant: 2 }), /between 0 and 1/);
  assert.throws(() => new AudioFeatureExtractor({ bandCount: 2 }), /at least 3/);
});

test("reuses its frame and buffers", () => {
  const extractor = new AudioFeatureExtractor();
  const first = extractor.update(quietBands(), 16);
  const second = extractor.update(quietBands(), 32);

  assert.equal(first, second);
  assert.equal(first.bands, second.bands);
  assert.equal(first.features, second.features);
});

test("extracts broad frequency energy", () => {
  const extractor = new AudioFeatureExtractor();
  const bands = quietBands();
  bands.fill(0.8, 0, 7);
  const frame = extractor.update(bands, 16);

  assert.ok(frame.features.bass > frame.features.mids * 10);
  assert.ok(frame.features.bass > frame.features.treble * 10);
  assert.ok(frame.features.energy > 0);
});

test("determines every broad-band value, total energy, and flux", () => {
  const extractor = new AudioFeatureExtractor();
  const bands = new Float32Array(24);
  bands.fill(0.8, 0, 7);
  bands.fill(0.4, 7, 16);
  bands.fill(0.2, 16);

  const risingFrame = extractor.update(bands, 16, { active: false });
  assertApproximately(risingFrame.features.bass, 0.8 * 0.72);
  assertApproximately(risingFrame.features.mids, 0.4 * 0.72);
  assertApproximately(risingFrame.features.treble, 0.2 * 0.72);
  assertApproximately(risingFrame.features.energy, 0.45 * 0.72);
  assertApproximately(
    risingFrame.features.flux,
    ((0.8 - 0.015) * 7 + (0.4 - 0.015) * 9 + (0.2 - 0.015) * 8) / 24,
  );

  const fallingFrame = extractor.update(quietBands(), 32, { active: false });
  assertApproximately(fallingFrame.features.bass, 0.8 * 0.72 + (0.015 - 0.8 * 0.72) * 0.24);
  assertApproximately(fallingFrame.features.mids, 0.4 * 0.72 + (0.015 - 0.4 * 0.72) * 0.24);
  assertApproximately(fallingFrame.features.treble, 0.2 * 0.72 + (0.015 - 0.2 * 0.72) * 0.24);
  assertApproximately(fallingFrame.features.energy, 0.45 * 0.72 + (0.015 - 0.45 * 0.72) * 0.24);
  assert.equal(fallingFrame.features.flux, 0);
});

test("converts analyzer decibels into all logarithmic spectrum bands", async () => {
  const track = {
    kind: "audio",
    contentHint: "",
    getSettings: () => ({ sampleRate: 48000 }),
  };
  const stream = { getAudioTracks: () => [track] };
  let decibels = -100;
  const analyserNode = {
    frequencyBinCount: 256,
    fftSize: 512,
    smoothingTimeConstant: 0,
    minDecibels: -100,
    maxDecibels: -20,
    getFloatFrequencyData: (data) => data.fill(decibels),
  };
  const sourceNode = { connect() {}, disconnect() {} };
  const audioContext = {
    state: "running",
    sampleRate: 48000,
    createMediaStreamSource: () => sourceNode,
    createAnalyser: () => analyserNode,
  };
  const analyzer = new AudioStreamAnalyzer({ audioContext });
  await analyzer.connect(stream);

  for (const band of analyzer.sample(16).bands) assertApproximately(band, 0.015);

  decibels = -60;
  for (const band of analyzer.sample(32).bands) assertApproximately(band, 0.5 ** 1.35);

  decibels = -20;
  assert.deepEqual([...analyzer.sample(48).bands], Array(24).fill(1));
  await analyzer.disconnect();
});

test("detects a causal kick after learning the baseline", () => {
  const extractor = new AudioFeatureExtractor();
  for (let index = 0; index < 20; index += 1) {
    extractor.update(quietBands(), index * 16);
  }

  const kick = quietBands();
  kick.fill(0.85, 0, 7);
  const frame = extractor.update(kick, 400);

  assert.ok(frame.features.kickPulse > 0.5);
  assert.equal(frame.features.beatCount, 1);
});

test("estimates BPM from repeated causal onsets", () => {
  const extractor = new AudioFeatureExtractor();
  let timestamp = 0;

  for (let beat = 1; beat <= 5; beat += 1) {
    const beatAt = beat * 500;
    while (timestamp < beatAt - 16) {
      timestamp += 16;
      extractor.update(quietBands(), timestamp);
    }
    timestamp = beatAt;
    const kick = quietBands();
    kick.fill(0.85, 0, 7);
    extractor.update(kick, timestamp);
  }

  assert.ok(extractor.features.beatCount >= 4);
  assert.equal(extractor.features.bpm, 120);
});

test("estimates common tempos independently of sampling rate", () => {
  for (const bpm of [60, 90, 120, 180]) {
    for (const framesPerSecond of [30, 60, 120]) {
      const extractor = new AudioFeatureExtractor();
      const beatInterval = 60000 / bpm;
      const frameInterval = 1000 / framesPerSecond;
      let timestamp = 0;

      for (let beat = 1; beat <= 8; beat += 1) {
        const beatAt = beat * beatInterval;
        while (timestamp < beatAt - frameInterval) {
          timestamp += frameInterval;
          extractor.update(quietBands(), timestamp);
        }
        timestamp = beatAt;
        const onset = quietBands();
        onset.fill(0.85, 0, 7);
        extractor.update(onset, timestamp);
      }

      assert.equal(
        extractor.features.bpm,
        bpm,
        `Expected ${bpm} BPM when sampled at ${framesPerSecond} FPS.`,
      );
    }
  }
});

test("reset clears every derived value and restores idle bands", () => {
  const extractor = new AudioFeatureExtractor();
  const loudBands = new Float32Array(24).fill(1);
  extractor.update(loudBands, 16);
  const frame = extractor.reset();

  assert.equal(frame.active, false);
  assert.equal(frame.timestamp, 0);
  assert.deepEqual(frame.features, {
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
  for (const band of frame.bands) assertApproximately(band, 0.015);
});

test("rejects inputs without an audio track", async () => {
  const analyzer = new AudioStreamAnalyzer();
  await assert.rejects(analyzer.connect({ getAudioTracks: () => [] }), /MediaStream with audio/);
});

test("connects, samples, and disconnects without stopping the input track", async () => {
  let trackWasStopped = false;
  const track = {
    kind: "audio",
    contentHint: "",
    getSettings: () => ({ latency: 0.004, sampleRate: 48000 }),
    stop: () => { trackWasStopped = true; },
  };
  const stream = { getAudioTracks: () => [track] };
  const analyserNode = {
    frequencyBinCount: 256,
    fftSize: 512,
    smoothingTimeConstant: 0,
    minDecibels: -100,
    maxDecibels: -20,
    getFloatFrequencyData: (data) => {
      data.fill(-100);
      data.fill(-35, 1, 8);
    },
  };
  const sourceNode = {
    connectedTo: null,
    connect(node) { this.connectedTo = node; },
    disconnect() { this.connectedTo = null; },
  };
  const audioContext = {
    state: "running",
    sampleRate: 48000,
    baseLatency: 0.01,
    createMediaStreamSource: (input) => {
      assert.equal(input, stream);
      return sourceNode;
    },
    createAnalyser: () => analyserNode,
  };
  const analyzer = new AudioStreamAnalyzer({ audioContext });

  await analyzer.connect(stream);
  const frame = analyzer.sample(16);

  assert.equal(analyzer.connected, true);
  assert.equal(frame.active, true);
  assert.ok(frame.features.energy > 0);
  assert.equal(analyzer.diagnostics.captureLatencyMilliseconds, 4);
  assert.equal(analyzer.diagnostics.fftWindowMilliseconds, 512 / 48000 * 1000);
  assert.equal(track.contentHint, "music");

  await analyzer.disconnect();
  assert.equal(analyzer.connected, false);
  assert.equal(trackWasStopped, false);
});
