export function installWindowShortcuts(window, platform = process.platform) {
  const usesAsynchronousFullscreen = platform === "darwin";
  let desiredFullscreen = window.isFullScreen();
  let fullscreenTransitionPending = false;

  function applyDesiredFullscreen() {
    if (window.isFullScreen() === desiredFullscreen) {
      fullscreenTransitionPending = false;
      return;
    }

    fullscreenTransitionPending = true;
    window.setFullScreen(desiredFullscreen);
  }

  function finishFullscreenTransition() {
    if (!fullscreenTransitionPending) {
      desiredFullscreen = window.isFullScreen();
      return;
    }

    fullscreenTransitionPending = false;
    applyDesiredFullscreen();
  }

  if (usesAsynchronousFullscreen) {
    window.on("enter-full-screen", finishFullscreenTransition);
    window.on("leave-full-screen", finishFullscreenTransition);
  }

  window.webContents.on("before-input-event", (event, input) => {
    const isFullscreenShortcut = input.type === "keyDown"
      && input.key === "Enter"
      && input.alt
      && !input.isAutoRepeat
      && !input.control
      && !input.meta
      && !input.shift;

    if (!isFullscreenShortcut) return;

    event.preventDefault();
    if (!usesAsynchronousFullscreen) {
      window.setFullScreen(!window.isFullScreen());
      return;
    }

    desiredFullscreen = !desiredFullscreen;
    if (!fullscreenTransitionPending) applyDesiredFullscreen();
  });
}
