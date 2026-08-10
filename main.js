"use strict";

// SDL reads hints from the environment; without this one it drops controller
// input the moment the game has focus — which is exactly when we need the
// summon chord. Must be set before @kmamal/sdl is loaded.
process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS = process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS || "1";

const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, screen, globalShortcut } = require("electron");
const { loadConfig, tokenStore } = require("./src/config");
const { DiscordBridge } = require("./src/discord");
const { ControllerInput } = require("./src/controller");

let config;
try {
  config = loadConfig();
} catch (err) {
  // Installed builds have no console — a blocking dialog is the only way the
  // first-run instructions actually reach the user.
  console.error(err.message);
  try {
    dialog.showErrorBox("CouchCord", err.message);
  } catch {}
  app.exit(1);
  process.exit(1);
}

const bridge = new DiscordBridge({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  tokenStore,
});

const controllers = new ControllerInput({
  chord: config.chord,
  chordHoldMs: config.chordHoldMs,
});

const HUD_W = 300;
const HUD_H = 420;
const PANEL_W = 660;
const PANEL_H = 640;
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

function panelBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(Math.round(PANEL_W * config.hudScale), wa.width - MARGIN * 2);
  const h = Math.min(Math.round(PANEL_H * config.hudScale), wa.height - MARGIN * 2);
  return {
    x: wa.x + Math.round((wa.width - w) / 2),
    y: wa.y + Math.round((wa.height - h) / 2),
    width: w,
    height: h,
  };
}

// The panel takes focus so Steam Input stops routing the controller to the
// game while it's open; closing hands focus straight back.
function openPanel() {
  if (ui.panelOpen || !win || win.isDestroyed()) return;
  ui.panelOpen = true;
  win.setBounds(panelBounds());
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.show();
  win.focus();
  win.setAlwaysOnTop(true, "screen-saver"); // reassert; focusable flips can drop z-order
  pushState();
}

function closePanel() {
  if (!ui.panelOpen || !win || win.isDestroyed()) return;
  ui.panelOpen = false;
  win.setIgnoreMouseEvents(true);
  win.blur(); // on Windows this returns focus to the previous foreground window (the game)
  win.setFocusable(false);
  win.setBounds(hudBounds());
  win.setAlwaysOnTop(true, "screen-saver");
  pushState();
}

function togglePanel() {
  if (ui.panelOpen) closePanel();
  else openPanel();
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
    icon: path.join(__dirname, "assets", "icon.png"),
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
    controllerFamily: controllers.activeFamily,
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

controllers.on("log", (line) => console.log(`[couchcord] ${line}`));
controllers.on("chord", togglePanel);
controllers.on("nav", (action) => {
  if (ui.panelOpen && win && !win.isDestroyed()) win.webContents.send("nav", action);
});
let lastFamily = controllers.activeFamily;
controllers.on("activity", (family) => {
  if (family !== lastFamily) {
    lastFamily = family;
    pushState(); // update button-hint glyphs to the pad actually in use
  }
});

const logFail = (what) => (err) => console.log(`[couchcord] ${what} failed: ${err.message}`);

ipcMain.on("action", (_e, { type, payload } = {}) => {
  switch (type) {
    case "toggleMute":
      bridge.toggleMute().catch(logFail("mute"));
      break;
    case "toggleDeafen":
      bridge.toggleDeafen().catch(logFail("deafen"));
      break;
    case "disconnect":
      bridge.disconnectVoice().catch(logFail("disconnect"));
      break;
    case "join":
      bridge.joinVoiceChannel(payload).catch(logFail("join"));
      break;
    case "closePanel":
      closePanel();
      break;
    case "toggleHud":
      hudHidden = !hudHidden;
      pushState();
      break;
    case "quit":
      app.quit();
      break;
  }
});

ipcMain.handle("listGuilds", () =>
  bridge.listGuilds().catch((err) => {
    logFail("server list")(err);
    return null;
  })
);

ipcMain.handle("listChannels", (_e, guildId) =>
  bridge.listVoiceChannels(guildId).catch((err) => {
    logFail("channel list")(err);
    return null;
  })
);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    createWindow();
    bridge.start();
    controllers.start();
    // Keyboard fallback for testing without a pad in hand.
    if (config.debugHotkey) {
      try {
        globalShortcut.register(config.debugHotkey, togglePanel);
      } catch (err) {
        logFail(`registering debug hotkey ${config.debugHotkey}`)(err);
      }
    }
    if (process.platform === "win32") {
      const login = { openAtLogin: !!config.launchOnLogin };
      if (!app.isPackaged) {
        // Dev checkout: the login item must be electron.exe + the app dir.
        // Installed builds register their own exe (the default).
        login.path = process.execPath;
        login.args = [path.resolve(__dirname)];
      }
      app.setLoginItemSettings(login);
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    bridge.stop();
  });
}
