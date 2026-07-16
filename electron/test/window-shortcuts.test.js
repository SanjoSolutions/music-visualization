import assert from "node:assert/strict";
import test from "node:test";
import { installWindowShortcuts } from "../window-shortcuts.js";

function createWindow(fullscreen = false, platform = "win32") {
  let handler;
  const windowHandlers = new Map();
  const fullscreenChanges = [];
  const window = {
    webContents: {
      on(event, callback) {
        assert.equal(event, "before-input-event");
        handler = callback;
      },
    },
    on(event, callback) {
      windowHandlers.set(event, callback);
    },
    isFullScreen: () => fullscreen,
    setFullScreen(value) {
      fullscreenChanges.push(value);
      if (platform !== "darwin") fullscreen = value;
    },
  };
  installWindowShortcuts(window, platform);
  return {
    fullscreenChanges,
    invoke: (event, input) => handler(event, input),
    finishTransition(value) {
      fullscreen = value;
      windowHandlers.get(value ? "enter-full-screen" : "leave-full-screen")();
    },
  };
}

test("Alt+Enter toggles fullscreen and consumes the shortcut", () => {
  const { fullscreenChanges, invoke } = createWindow();
  let prevented = false;

  invoke({ preventDefault: () => { prevented = true; } }, {
    type: "keyDown",
    key: "Enter",
    alt: true,
    control: false,
    meta: false,
    shift: false,
  });

  assert.equal(prevented, true);
  assert.deepEqual(fullscreenChanges, [true]);
});

test("Alt+Enter exits fullscreen when already fullscreen", () => {
  const { fullscreenChanges, invoke } = createWindow(true);

  invoke({ preventDefault() {} }, {
    type: "keyDown",
    key: "Enter",
    alt: true,
    control: false,
    meta: false,
    shift: false,
  });

  assert.deepEqual(fullscreenChanges, [false]);
});

test("Alt+Enter can exit fullscreen after entering on Windows", () => {
  const { fullscreenChanges, invoke } = createWindow();
  const input = {
    type: "keyDown",
    key: "Enter",
    alt: true,
    control: false,
    meta: false,
    shift: false,
  };

  invoke({ preventDefault() {} }, input);
  invoke({ preventDefault() {} }, input);

  assert.deepEqual(fullscreenChanges, [true, false]);
});

test("rapid toggles are serialized while fullscreen is changing", () => {
  const { finishTransition, fullscreenChanges, invoke } = createWindow(false, "darwin");
  const input = {
    type: "keyDown",
    key: "Enter",
    alt: true,
    control: false,
    meta: false,
    shift: false,
  };

  invoke({ preventDefault() {} }, input);
  invoke({ preventDefault() {} }, input);
  assert.deepEqual(fullscreenChanges, [true]);

  finishTransition(true);
  assert.deepEqual(fullscreenChanges, [true, false]);
});

test("native fullscreen changes update the shortcut state", () => {
  const { finishTransition, fullscreenChanges, invoke } = createWindow(false, "darwin");

  finishTransition(true);
  assert.deepEqual(fullscreenChanges, []);

  invoke({ preventDefault() {} }, {
    type: "keyDown",
    key: "Enter",
    alt: true,
    control: false,
    meta: false,
    shift: false,
  });
  assert.deepEqual(fullscreenChanges, [false]);
});

test("other input does not toggle fullscreen", () => {
  const inputs = [
    { type: "keyUp", key: "Enter", alt: true },
    { type: "keyDown", key: "Enter", alt: false },
    { type: "keyDown", key: "Enter", alt: true, isAutoRepeat: true },
    { type: "keyDown", key: "Enter", alt: true, control: true },
    { type: "keyDown", key: "Escape", alt: true },
  ];

  for (const input of inputs) {
    const { fullscreenChanges, invoke } = createWindow();
    invoke({ preventDefault() {} }, input);
    assert.deepEqual(fullscreenChanges, []);
  }
});
