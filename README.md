# Music Visualization

![Visualization 1 showing a mirrored 24-band spectrum](./docs/visualization-1.png)

A cross-platform system-audio visualizer for Electron, with a browser fallback. Audio is analyzed locally and is never uploaded or recorded.

Audio analysis lives in the reusable [`music-audio-features`](./packages/music-audio-features) workspace package. It accepts a browser `MediaStream` or audio `MediaStreamTrack` and returns spectrum bands plus higher-level music features without handling capture permissions itself.

## Visualizations

- **1** — a mirrored 24-band display.
- **1-hsl** — the same mirrored 24-band display with a continuously changing HSL hue that completes a full color cycle every six minutes.
- **2** — luminous, audio-reactive ribbons orbiting a dark core.
- **3** — a radial field of colored rays, particles, and rings.

The canvas fills the viewport. Use the **Left Arrow** and **Right Arrow** keys to switch visualizations. The selected mode is stored in the URL as `?visualization=<id>` using `history.replaceState`, so switching modes does not add history entries.

## Run locally

```bash
npm install
npm run dev
```

Open the localhost URL shown by Vite in a Chromium-based browser. Click **Start system audio**, choose **Entire Screen**, enable **Share system audio**, and start playback in any application.

Browser display capture always includes a video track. This app keeps that permission track alive but disables and never renders it; only the captured audio track is connected to the analyzer.

## Run the desktop app

```bash
npm install
npm run electron:dev
```

Press **Alt + Enter** to toggle between fullscreen and windowed mode.
System-audio capture starts automatically when the Electron window opens. If capture cannot start, the on-screen button remains available to retry.

The capture adapter is selected by platform while the analyzer and all visualizations stay shared:

- **Windows:** native WASAPI loopback, with no permission picker or video capture. The packaged helper is self-contained; development builds require the .NET SDK.
- **Linux:** the PulseAudio-compatible `parec` client captures PipeWire/PulseAudio's default monitor source directly, with no video capture. Install `pulseaudio-utils` if your distribution does not provide `parec` through PipeWire Pulse compatibility.
- **macOS 14.2+:** a native Core Audio process tap captures a mono mix without screen frames. Apple shows a one-time system-audio permission prompt; the packaged app and helper include the required usage description. Older macOS releases need a virtual audio device and are not supported by the direct adapter.

In Electron, native mono PCM stays in the backend and is analyzed in a dedicated worker. Only compact spectrum/feature frames cross into the renderer; the browser build continues to use Web Audio with the same causal feature extractor.

Build the current platform's installer with `npm run electron:build`.

## Browser notes

- System-audio options depend on the browser and operating system.
- `getDisplayMedia()` requires localhost or HTTPS and a user click.
- If no audio track is returned, the app stops the capture and explains how to retry.
