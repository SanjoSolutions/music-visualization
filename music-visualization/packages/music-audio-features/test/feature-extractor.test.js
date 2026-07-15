import test from "node:test";
import assert from "node:assert/strict";

import { AudioFeatureExtractor, AudioStreamAnalyzer } from "../src/index.js";

const quietBands = () => new Float32Array(24).fill(0.015);

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
