import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const directory = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let captureProcess = null;
let captureOwner = null;
let analysisWorker = null;

function helperPath() {
  const helperDirectory = process.platform === "darwin" ? "macos-loopback" : "windows-loopback";
  const executable = process.platform === "darwin" ? "SystemAudioCapture" : "SystemAudioCapture.exe";
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "native", helperDirectory, executable);
  }
  return path.join(directory, "..", "native", helperDirectory, "publish", executable);
}

function stopCapture() {
  const process = captureProcess;
  captureProcess = null;
  captureOwner = null;
  stopAnalysis();
  if (!process || process.killed) return;
  process.stdin?.end();
  setTimeout(() => {
    if (process.exitCode === null) process.kill();
  }, 500).unref();
}

function stopAnalysis() {
  const worker = analysisWorker;
  analysisWorker = null;
  if (worker) void worker.terminate();
}

function startAnalysis(webContents, sampleRate) {
  stopAnalysis();
  const options = { sampleRate, bandCount: 24, fftSize: 2048, hopSize: 512 };
  const worker = new Worker(new URL("./audio-analysis-worker.js", import.meta.url));
  analysisWorker = worker;
  worker.on("message", (frame) => {
    if (analysisWorker === worker && !webContents.isDestroyed()) {
      webContents.send("system-audio:frame", frame);
    }
  });
  worker.on("error", (error) => {
    if (analysisWorker !== worker) return;
    if (!webContents.isDestroyed()) webContents.send("system-audio:ended", error.message);
    stopCapture();
  });
  worker.postMessage({ type: "configure", options });
  return {
    causal: true,
    connected: true,
    backendAnalysis: true,
    captureLatencyMilliseconds: process.platform === "darwin" ? null : 20,
    contextBaseLatencyMilliseconds: null,
    sampleRate,
    fftSize: options.fftSize,
    hopSize: options.hopSize,
    fftWindowMilliseconds: options.fftSize / sampleRate * 1000,
    analyserSmoothing: 0,
    bandCount: options.bandCount,
  };
}

function forwardAudio(chunk) {
  if (!analysisWorker || !chunk.length) return;
  const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
  analysisWorker.postMessage({ type: "pcm", buffer }, [buffer]);
}

function attachRawCapture(webContents, child, sampleRate) {
  captureProcess = child;
  captureOwner = webContents;
  let started = false;
  let errorOutput = "";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail(new Error("System audio capture did not start in time.")), 5000);

    function fail(error) {
      clearTimeout(timeout);
      if (captureProcess === child) stopCapture();
      reject(error);
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => { errorOutput += text; });
    child.on("error", fail);
    child.on("spawn", () => {
      started = true;
      clearTimeout(timeout);
      resolve(startAnalysis(webContents, sampleRate));
    });
    child.stdout.on("data", (chunk) => {
      forwardAudio(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      const wasCurrentCapture = captureProcess === child;
      if (wasCurrentCapture) {
        captureProcess = null;
        captureOwner = null;
        stopAnalysis();
      }
      const message = errorOutput.trim() || (code ? `System audio capture exited with code ${code}.` : "");
      if (!started) reject(new Error(message || "System audio capture could not start."));
      else if (wasCurrentCapture && !webContents.isDestroyed()) webContents.send("system-audio:ended", message);
    });
  });
}

function startCompiledCapture(webContents) {
  stopCapture();

  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    captureProcess = child;
    captureOwner = webContents;

    let header = Buffer.alloc(0);
    let started = false;
    let errorOutput = "";
    const timeout = setTimeout(() => fail(new Error("System audio capture did not start in time.")), 5000);

    function fail(error) {
      clearTimeout(timeout);
      if (captureProcess === child) stopCapture();
      reject(error);
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => { errorOutput += text; });
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      const wasCurrentCapture = captureProcess === child;
      if (wasCurrentCapture) {
        captureProcess = null;
        captureOwner = null;
        stopAnalysis();
      }
      if (!started) {
        reject(new Error(errorOutput.trim() || `System audio capture exited with code ${code}.`));
      } else if (wasCurrentCapture && !webContents.isDestroyed()) {
        webContents.send("system-audio:ended", errorOutput.trim());
      }
    });

    child.stdout.on("data", (chunk) => {
      if (!started) {
        header = Buffer.concat([header, chunk]);
        if (header.length < 4) return;
        const sampleRate = header.readUInt32LE(0);
        const audio = header.subarray(4);
        started = true;
        clearTimeout(timeout);
        resolve(startAnalysis(webContents, sampleRate));
        forwardAudio(audio);
        return;
      }
      forwardAudio(chunk);
    });
  });
}

function startLinuxCapture(webContents) {
  stopCapture();
  const sampleRate = 48000;
  const child = spawn("parec", [
    "--device=@DEFAULT_MONITOR@",
    "--format=float32le",
    `--rate=${sampleRate}`,
    "--channels=1",
    "--latency-msec=20",
    "--raw",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  return attachRawCapture(webContents, child, sampleRate);
}

function startCapture(webContents) {
  if (process.platform === "win32" || process.platform === "darwin") return startCompiledCapture(webContents);
  if (process.platform === "linux") return startLinuxCapture(webContents);
  throw new Error("Direct native audio capture is not available on this platform.");
}

app.whenReady().then(() => {
  ipcMain.handle("system-audio:start", (event) => startCapture(event.sender));
  ipcMain.handle("system-audio:stop", (event) => {
    if (event.sender === captureOwner) stopCapture();
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#070708",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("closed", () => {
    stopCapture();
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(directory, "..", "dist", "index.html"));
  }
});

app.on("window-all-closed", () => {
  stopCapture();
  app.quit();
});
