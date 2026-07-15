# Music Visualization

A browser-based system-audio visualizer that ports the mirrored spectrum and visual language from the Afterhours app into a standalone project. Audio is analyzed locally with the Web Audio API and is never uploaded or recorded.

## Run locally

```bash
npm install
npm run dev
```

Open the localhost URL shown by Vite in a Chromium-based browser. Click **Share system audio**, choose **Entire Screen**, enable **Share system audio**, and start playback in any application.

Browser display capture always includes a video track. This app keeps that permission track alive but disables and never renders it; only the captured audio track is connected to the analyzer.

## Browser notes

- System-audio options depend on the browser and operating system.
- `getDisplayMedia()` requires localhost or HTTPS and a user click.
- If no audio track is returned, the app stops the capture and explains how to retry.
