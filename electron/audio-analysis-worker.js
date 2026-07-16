import { parentPort } from "node:worker_threads";
import { PcmStreamAnalyzer } from "music-audio-features";

let analyzer = null;
let byteRemainder = new Uint8Array(0);

parentPort.on("message", (message) => {
  if (message.type === "configure") {
    analyzer = new PcmStreamAnalyzer(message.options);
    byteRemainder = new Uint8Array(0);
    return;
  }
  if (message.type !== "pcm" || !analyzer) return;

  const incoming = new Uint8Array(message.buffer);
  let complete = incoming;
  if (byteRemainder.length) {
    complete = new Uint8Array(byteRemainder.length + incoming.length);
    complete.set(byteRemainder);
    complete.set(incoming, byteRemainder.length);
  }
  const completeByteLength = complete.length - complete.length % Float32Array.BYTES_PER_ELEMENT;
  byteRemainder = complete.slice(completeByteLength);
  if (!completeByteLength) return;

  const samples = new Float32Array(complete.buffer, complete.byteOffset, completeByteLength / Float32Array.BYTES_PER_ELEMENT);
  analyzer.push(samples, (frame) => {
    const bands = new Float32Array(frame.bands);
    parentPort.postMessage({
      active: frame.active,
      timestamp: frame.timestamp,
      bands,
      features: { ...frame.features },
    }, [bands.buffer]);
  });
});
