"use strict";

// SDL reads hints from the environment; without this one it drops controller
// input the moment the game has focus — which is exactly when we need the
// summon chord. Must be set before @kmamal/sdl is loaded.
process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS = process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS || "1";

const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, screen, shell, globalShortcut } = require("electron");
const { loadConfig, saveCredentials, updateConfig, tokenStore, CONFIG_PATH, DATA_DIR } = require("./src/config");
const { createLogger } = require("./src/log");
const { DiscordBridge } = require("./src/discord");
const { ControllerInput } = require("./src/controller");

const logger = createLogger(DATA_DIR);
const log = (line) => logger.log(`[couchcord] ${line}`);
log(`CouchCord ${app.getVersion()} starting (packaged: ${app.isPackaged})`);

let config = null;
try {
  config = loadConfig();
} catch (err) {
  if (err.code !== "NEEDS_SETUP") {
    // A real error (e.g. corrupt config.json) — installed builds have no
    // console, so a blocking dialog is the only way it reaches the user.
    log(err.message);
    try {
      dialog.showErrorBox("CouchCord", err.message);
    } catch {}
    app.exit(1);
    process.exit(1);
  }
  log("No credentials yet — opening the setup wizard");
  // Missing credentials: fall through to the first-run setup wizard.
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (!config) {
  runSetup();
} else {
  runOverlay();
}

// ---- first-run setup wizard -------------------------------------------------

function runSetup() {
  ipcMain.handle("saveCredentials", (_e, creds = {}) => {
    const clientId = String(creds.clientId || "").trim();
    const clientSecret = String(creds.clientSecret || "").trim();
    if (!/^\d{15,25}$/.test(clientId)) {
      return { error: "That Client ID doesn't look right — it's a long number, like 1234567890123456789." };
    }
    if (clientSecret.length < 10 || /\s/.test(clientSecret)) {
      return { error: "That Client Secret looks wrong — on the OAuth2 page use Reset Secret, then copy the new value." };
    }
    try {
      saveCredentials({ clientId, clientSecret });
    } catch (err) {
      return { error: `Could not write config.json: ${err.message}` };
    }
    // Brief pause so the renderer can show "Restarting…", then come back up
    // with a complete config.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 600);
    return { ok: true };
  });

  // Fixed URL opened from the main process — the renderer only rings a bell.
  ipcMain.on("openPortal", () => shell.openExternal("https://discord.com/developers/applications"));

  ipcMain.on("action", (_e, { type } = {}) => {
    if (type === "quit") app.quit();
  });

  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 700,
      height: 760,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      hasShadow: false,
      title: "CouchCord setup",
      icon: path.join(__dirname, "assets", "icon.png"),
      webPreferences: {
        preload: path.join(__dirname, "overlay", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadFile(path.join(__dirname, "overlay", "overlay.html"));
    win.webContents.on("did-finish-load", () => {
      win.webContents.send("state", { setupMode: true, configPath: CONFIG_PATH });
      win.show();
    });
  });

  app.on("window-all-closed", () => app.quit());
}

// ---- the overlay proper -----------------------------------------------------

function runOverlay() {
  const bridge = new DiscordBridge({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenStore,
  });

  const controllers = new ControllerInput({
    chord: config.chord,
    chordHoldMs: config.chordHoldMs,
  });

  const HUD_W = 320;
  const HUD_H = 440;
  const PANEL_W = 700;
  const PANEL_H = 680;
  // The renderer pads the window interior for shadow room, so the window
  // itself hugs the screen edge more closely.
  const MARGIN = 4;

  let win = null;
  let hudHidden = false;
  const ui = { panelOpen: false, capturing: false, captureHeld: [] };
  let captureTimeout = null;

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
      hudOpacity: config.hudOpacity,
      hudMode: config.hudMode,
      controllerFamily: controllers.activeFamily,
      chord: config.chord,
      chordHoldMs: config.chordHoldMs,
      launchOnLogin: !!config.launchOnLogin,
      capturing: ui.capturing,
      captureHeld: ui.captureHeld,
    };
  }

  // Ends learn mode from any path: Esc, controller cancel, timeout, capture
  // completion, or the panel closing.
  function endCapture() {
    if (!ui.capturing) return;
    ui.capturing = false;
    ui.captureHeld = [];
    clearTimeout(captureTimeout);
    try {
      globalShortcut.unregister("Escape");
    } catch {}
  }

  function stopCapture() {
    if (!ui.capturing) return;
    endCapture();
    controllers.cancelCapture();
    log("Chord learn mode cancelled");
  }

  function applyLoginItem() {
    if (process.platform !== "win32") return;
    const login = { openAtLogin: !!config.launchOnLogin };
    if (!app.isPackaged) {
      // Dev checkout: the login item must be electron.exe + the app dir.
      // Installed builds register their own exe (the default).
      login.path = process.execPath;
      login.args = [path.resolve(__dirname)];
    }
    app.setLoginItemSettings(login);
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

  bridge.on("log", log);
  bridge.on("update", pushState);

  // Fresh authorization means a first run (or re-auth) — open the panel so
  // the user can see CouchCord actually running instead of a hidden window.
  bridge.on("authorized", () => {
    if (!ui.panelOpen) openPanel();
  });

  // Interactive authorization failed; retrying would loop the Authorize
  // popup forever, so the bridge stopped. Tell the user what happened.
  bridge.on("fatal", (message) => {
    dialog
      .showMessageBox({
        type: "error",
        title: "CouchCord",
        message: "Discord authorization failed",
        detail:
          `${message}\n\n` +
          "Common causes:\n" +
          "• Your Discord application has no Redirect URI: on its OAuth2 page, under Redirects, click Add Redirect, enter exactly http://127.0.0.1 and Save Changes — then Try again.\n" +
          "• The Discord desktop app is logged into a different account than the one that owns your Discord application — they must be the same account.\n" +
          "• The Client Secret was pasted wrong — on the app's OAuth2 page use Reset Secret and copy the new value (Redo setup below).\n\n" +
          `Full log: ${logger.file}`,
        buttons: ["Try again", "Redo setup", "Quit"],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (response === 0) {
          app.relaunch();
          app.exit(0);
        } else if (response === 1) {
          saveCredentials({ clientId: "", clientSecret: "" }); // wizard opens on relaunch
          app.relaunch();
          app.exit(0);
        } else {
          app.quit();
        }
      });
  });

  controllers.on("log", log);
  controllers.on("chord", () => {
    if (!ui.capturing) togglePanel();
  });
  controllers.on("nav", (action) => {
    if (ui.capturing) return;
    if (ui.panelOpen && win && !win.isDestroyed()) win.webContents.send("nav", action);
  });
  controllers.on("captureUpdate", (held) => {
    ui.captureHeld = held;
    pushState();
  });
  controllers.on("chordCaptured", (chord) => {
    endCapture();
    config.chord = chord;
    try {
      updateConfig({ chord });
      log(`Summon chord remapped to: ${chord.join(" + ")}`);
    } catch (err) {
      logFail("saving remapped chord")(err);
    }
    pushState();
  });
  controllers.on("captureCancelled", () => {
    endCapture();
    log("Chord learn mode cancelled from the controller");
    pushState();
  });
  let lastFamily = controllers.activeFamily;
  controllers.on("activity", (family) => {
    if (family !== lastFamily) {
      lastFamily = family;
      pushState(); // update button-hint glyphs to the pad actually in use
    }
  });

  const logFail = (what) => (err) => log(`${what} failed: ${err.message}`);

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
        stopCapture();
        closePanel();
        break;
      case "startChordCapture":
        ui.capturing = true;
        ui.captureHeld = [];
        controllers.startCapture();
        clearTimeout(captureTimeout);
        captureTimeout = setTimeout(() => {
          if (ui.capturing) {
            stopCapture();
            pushState();
          }
        }, 20000); // learn mode gives up after 20s of nothing captured
        // Global so Esc cancels even if window focus wandered (registered
        // only while learn mode is active).
        try {
          globalShortcut.register("Escape", () => {
            stopCapture();
            pushState();
          });
        } catch {}
        log("Chord learn mode started");
        pushState();
        break;
      case "cancelChordCapture":
        stopCapture();
        pushState();
        break;
      case "setSetting": {
        const { key, value } = payload || {};
        const allowed = {
          hudCorner: ["top-left", "top-right", "bottom-left", "bottom-right"],
          hudScale: [0.8, 1, 1.25, 1.5, 1.75, 2],
          hudOpacity: [0.5, 0.65, 0.85, 0.95],
          hudMode: ["full", "compact", "speaking"],
          chordHoldMs: [250, 400, 600, 800],
          launchOnLogin: [true, false],
        };
        if (!allowed[key] || !allowed[key].includes(value)) break;
        config[key] = value;
        try {
          updateConfig({ [key]: value });
        } catch (err) {
          logFail(`saving setting ${key}`)(err);
        }
        if (key === "chordHoldMs") controllers.chordHoldMs = value;
        if (key === "launchOnLogin") applyLoginItem();
        if (key === "hudScale" && ui.panelOpen && win && !win.isDestroyed()) win.setBounds(panelBounds());
        log(`Setting ${key} = ${value}`);
        pushState();
        break;
      }
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
    applyLoginItem();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    bridge.stop();
  });
}
