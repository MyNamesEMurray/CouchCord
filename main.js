"use strict";

// SDL reads hints from the environment; without this one it drops controller
// input the moment the game has focus — which is exactly when we need the
// summon chord. Must be set before @kmamal/sdl is loaded.
process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS = process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS || "1";

const path = require("node:path");
const { app, BrowserWindow, screen } = require("electron");
const { loadConfig, tokenStore } = require("./src/config");
const { DiscordBridge } = require("./src/discord");

const config = loadConfig();

const bridge = new DiscordBridge({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  tokenStore,
});

const HUD_W = 300;
const HUD_H = 420;
const MARGIN = 16;

let win = null;
let hudHidden = false;
const ui = { panelOpen: false };

function hudBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.round(HUD_W * config.hudScale);
  const h = Math.round(HUD_H * config.hudScale);
  const x = config.hudCorner.includes("left") ? wa.x + MARGIN : wa.x + wa.width - w - MARGIN;
  const y = config.hudCorner.includes("top") ? wa.y + MARGIN : wa.y + wa.height - h - MARGIN;
  return { x, y, width: w, height: h };
}

function createWindow() {
  win = new BrowserWindow({
    ...hudBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: "CouchCord",
    webPreferences: {
      preload: path.join(__dirname, "overlay", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // speaking indicators must stay live while the game has focus
    },
  });
  // "screen-saver" level floats above borderless-fullscreen games.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  win.loadFile(path.join(__dirname, "overlay", "overlay.html"));
  win.webContents.on("did-finish-load", () => pushState());
}

function buildState() {
  return {
    ...bridge.snapshot(),
    hudHidden,
    panelOpen: ui.panelOpen,
    hudCorner: config.hudCorner,
    hudScale: config.hudScale,
  };
}

function updateVisibility() {
  if (!win || win.isDestroyed()) return;
  if (ui.panelOpen) {
    if (!win.isVisible()) win.show();
    return;
  }
  const s = bridge.snapshot();
  if (s.connected && s.channel && !hudHidden) {
    // showInactive + focusable:false — the HUD must never steal game focus.
    if (!win.isVisible()) win.showInactive();
  } else {
    win.hide();
  }
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send("state", buildState());
  updateVisibility();
}

bridge.on("log", (line) => console.log(`[couchcord] ${line}`));
bridge.on("update", pushState);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    createWindow();
    bridge.start();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    bridge.stop();
  });
}
