import { spawn } from "node:child_process";
import electron from "electron";
import { createServer } from "vite";

const server = await createServer({
  server: {
    host: "127.0.0.1",
  },
});

await server.listen();
server.printUrls();

const rendererUrl = server.resolvedUrls?.local?.[0];
if (!rendererUrl) {
  await server.close();
  throw new Error("Vite did not provide a local renderer URL.");
}

const electronProcess = spawn(electron, ["."], {
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: rendererUrl,
  },
  stdio: "inherit",
  windowsHide: false,
});

let closing = false;
async function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  if (electronProcess.exitCode === null && !electronProcess.killed) electronProcess.kill();
  await server.close();
  process.exitCode = exitCode;
}

electronProcess.on("error", async (error) => {
  console.error(error);
  await close(1);
});

electronProcess.on("exit", async (code, signal) => {
  await close(signal ? 1 : (code ?? 0));
});

process.on("SIGINT", () => close(0));
process.on("SIGTERM", () => close(0));
