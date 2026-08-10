"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ponytail: config lives next to the sources because CouchCord runs from a
// checkout on the HTPC. If this ever gets packaged (asar), move config.json
// and token.json to Electron's app.getPath("userData").
const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const EXAMPLE_PATH = path.join(ROOT, "config.example.json");
const TOKEN_PATH = path.join(ROOT, "token.json");

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

// Loads config.json, creating it from the example on first run. Exits the
// process with instructions when credentials are missing — every entry point
// needs them, so there is no point continuing.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
    console.error(
      "Created config.json. Fill in clientId and clientSecret from your Discord\n" +
        "application (see README \"Discord setup\") and run this again."
    );
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    console.error(`config.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const config = { ...DEFAULTS, ...parsed };
  if (!config.clientId || !config.clientSecret) {
    console.error(
      "config.json is missing clientId and/or clientSecret. Create a Discord\n" +
        "application at https://discord.com/developers/applications and copy both\n" +
        "values in (see README \"Discord setup\")."
    );
    process.exit(1);
  }
  return config;
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

module.exports = { loadConfig, tokenStore, CONFIG_PATH };
