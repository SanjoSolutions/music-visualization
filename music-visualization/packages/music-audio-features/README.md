# music-audio-features

Low-latency, causal music analysis for browser `MediaStream` audio. The package produces a logarithmic spectrum plus higher-level bass, mids, treble, energy, spectral flux, kick, beat, and BPM data. It does not predict future beats.

## Install

```bash
npm install music-audio-features
```

## Use

```js
import { AudioStreamAnalyzer } from "music-audio-features";

const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const analyzer = new AudioStreamAnalyzer();
await analyzer.connect(stream);

function render(timestamp) {
  const { active, bands, features } = analyzer.sample(timestamp);
  if (active) {
    console.log(features.bass, features.kickPulse, features.bpm, bands);
  }
  requestAnimationFrame(render);
}

requestAnimationFrame(render);
```

`connect()` accepts either a `MediaStream` or an audio `MediaStreamTrack`. The caller owns the input stream and remains responsible for stopping its tracks. `disconnect()` releases the package's Web Audio resources without stopping the input.

## Output

Each frame contains:

- `active` — whether a live audio source is connected.
- `timestamp` — the timestamp supplied to `sample()`.
- `bands` — 24 logarithmically spaced, normalized spectrum bands by default.
- `features.bass`, `mids`, `treble`, and `energy` — smoothed values from `0` to `1`.
- `features.flux` — the current positive spectral change.
- `features.kickPulse` and `beatPulse` — causal onset envelopes that jump on detection and decay toward `0`.
- `features.beatCount` and `bpm` — detected beat count and tempo estimate; BPM remains `null` until enough intervals are available.

## Real-time behavior

`sample()` is designed to be called from an existing render loop. It returns the same mutable frame, feature object, and `Float32Array` on every call to avoid per-frame allocation. Copy values if they must be retained.

Defaults favor responsive visualization: a 512-sample FFT, no analyzer smoothing, 24 logarithmic bands, causal envelopes, and onset-based kick and beat detection. Options can be passed to the constructor. Runtime settings and reported browser latency values are available from `analyzer.diagnostics`.

The package targets browsers with the Web Audio and Media Capture APIs. It does not request microphone or display permissions itself.
