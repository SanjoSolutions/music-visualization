# Music Visualization

A browser-based system-audio visualizer that ports the mirrored spectrum and visual language from the Afterhours app into a standalone project. Audio is analyzed locally with the Web Audio API and is never uploaded or recorded.

## Visualizations

- **1** — a mirrored 24-band display.
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

## Browser notes

- System-audio options depend on the browser and operating system.
- `getDisplayMedia()` requires localhost or HTTPS and a user click.
- If no audio track is returned, the app stops the capture and explains how to retry.
