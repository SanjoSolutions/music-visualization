import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

test("analysis worker turns arbitrarily chunked PCM into compact feature frames", async (context) => {
  const worker = new Worker(new URL("../audio-analysis-worker.js", import.meta.url));
  context.after(() => worker.terminate());
  worker.postMessage({
    type: "configure",
    options: { sampleRate: 48000, bandCount: 24, fftSize: 2048, hopSize: 512 },
  });

  const samples = new Float32Array(4096);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * 110 * index / 48000) * 0.7;
  }
  const bytes = new Uint8Array(samples.buffer);
  const first = bytes.slice(0, 3).buffer;
  const second = bytes.slice(3).buffer;
  worker.postMessage({ type: "pcm", buffer: first }, [first]);
  worker.postMessage({ type: "pcm", buffer: second }, [second]);

  const frame = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Feature frame timed out.")), 3000);
    worker.once("message", (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    worker.once("error", reject);
  });

  assert.equal(frame.active, true);
  assert.ok(frame.bands instanceof Float32Array);
  assert.equal(frame.bands.length, 24);
  assert.ok(frame.features.bass > frame.features.treble * 2);
  assert.equal("pcm" in frame, false);
});
