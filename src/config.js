"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Under plain Node (spike.js), require("electron") resolves to the binary's
// path string instead of the API — treat that as "no Electron".
let electronApp = null;
try {
  const electron = require("electron");
  if (electron && typeof electron !== "string") electronApp = electron.app;
} catch {}

const ROOT = path.join(__dirname, "..");
// Installed builds keep the sources in a read-only asar, so the writable
// files live in the per-user data dir (%APPDATA%/CouchCord on Windows).
// Running from a checkout keeps everything in the repo root, as before.
const DATA_DIR = electronApp && electronApp.isPackaged ? electronApp.getPath("userData") : ROOT;
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const EXAMPLE_PATH = path.join(ROOT, "config.example.json");
const TOKEN_PATH = path.join(DATA_DIR, "token.json");

const DEFAULTS = {
  clientId: "",
  clientSecret: "",
  chord: ["back", "start"],
  chordHoldMs: 400,
  hudCorner: "top-right",
  hudScale: 1.0,
  debugHotkey: "F10",
  launchOnLogin: false,
};

// Loads config.json, creating it from the example on first run. Throws an
// Error when the app can't start with it: err.code "NEEDS_SETUP" means
// credentials are missing (the app shows the setup wizard; the spike prints
// instructions), anything else is a real error to surface as-is.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
    throw needsSetup();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }

  const config = { ...DEFAULTS, ...parsed };
  if (!config.clientId || !config.clientSecret) throw needsSetup();
  return config;
}

function needsSetup() {
  const err = new Error(
    `${CONFIG_PATH}\n\n` +
      "needs your Discord application's clientId and clientSecret. Create one\n" +
      "at https://discord.com/developers/applications and copy both values in\n" +
      '(see README "Discord setup").'
  );
  err.code = "NEEDS_SETUP";
  return err;
}

// Merges a partial update into config.json, preserving everything else the
// user already changed. Used by the setup wizard and in-app settings like
// the chord remap.
function updateConfig(partial) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  const merged = { ...DEFAULTS, ...existing, ...partial };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

function saveCredentials({ clientId, clientSecret }) {
  updateConfig({ clientId, clientSecret });
}

// Caches the Discord OAuth refresh token between runs so the authorization
// popup only appears once. Discord rotates refresh tokens, so the bridge
// re-saves whenever the library refreshes.
const tokenStore = {
  load() {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")).refreshToken || null;
    } catch {
      return null;
    }
  },
  save(refreshToken) {
    try {
      fs.writeFileSync(TOKEN_PATH, `${JSON.stringify({ refreshToken }, null, 2)}\n`);
    } catch (err) {
      console.warn(`Could not save token.json: ${err.message}`);
    }
  },
  clear() {
    try {
      fs.unlinkSync(TOKEN_PATH);
    } catch {}
  },
};

module.exports = { loadConfig, saveCredentials, updateConfig, tokenStore, CONFIG_PATH, DATA_DIR };
