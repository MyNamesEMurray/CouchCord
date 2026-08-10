#!/usr/bin/env node
"use strict";

// Phase 1 spike: prove the Discord RPC data path without any UI.
// Run `npm run spike` with the Discord desktop app open, join a voice
// channel, and watch membership + speaking events stream to the console.
// Kept around as a debugging tool now that the overlay exists.

const readline = require("node:readline");
const { loadConfig, tokenStore } = require("./src/config");
const { DiscordBridge } = require("./src/discord");

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const bridge = new DiscordBridge({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  tokenStore,
});

let lastChannels = []; // last listing, so number keys can join from it

const name = (userId) => {
  const m = bridge.snapshot().members.find((x) => x.id === userId);
  return m ? m.name : userId;
};

bridge.on("log", (line) => console.log(`[couchcord] ${line}`));

bridge.on("event", (evt, data) => {
  switch (evt) {
    case "VOICE_STATE_CREATE":
      console.log(`  + joined: ${data && data.nick ? data.nick : data?.user?.username}`);
      break;
    case "VOICE_STATE_DELETE":
      console.log(`  - left: ${name(data?.user?.id)}`);
      break;
    case "SPEAKING_START":
      console.log(`  » speaking: ${name(data?.user_id)}`);
      break;
    case "SPEAKING_STOP":
      console.log(`  « quiet:    ${name(data?.user_id)}`);
      break;
    case "VOICE_SETTINGS_UPDATE":
      console.log(`  ~ self: mute=${!!data?.mute} deaf=${!!data?.deaf}`);
      break;
  }
});

let lastChannelId = undefined;
bridge.on("update", (state) => {
  const id = state.channel ? state.channel.id : null;
  if (id === lastChannelId) return; // roster prints only on channel change
  lastChannelId = id;
  if (!state.channel) {
    console.log("[couchcord] Not in a voice channel");
    return;
  }
  console.log(`[couchcord] Voice channel: ${state.channel.name}`);
  for (const m of state.members) {
    console.log(`    ${m.self ? "*" : " "} ${m.name}${m.muted ? " (muted)" : ""}`);
  }
});

console.log("Keys: [m]ute  [d]eafen  [c]hannel list  [1-9] join listed channel  [x] disconnect  [q]uit");
bridge.start();

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

const act = (label, promise) =>
  promise.then(() => console.log(`[couchcord] ${label} ok`)).catch((err) => console.log(`[couchcord] ${label} failed: ${err.message}`));

process.stdin.on("keypress", (str, key) => {
  const k = key && key.name;
  if (k === "q" || (key && key.ctrl && k === "c")) {
    bridge.stop().finally(() => process.exit(0));
  } else if (k === "m") {
    act("toggle mute", bridge.toggleMute());
  } else if (k === "d") {
    act("toggle deafen", bridge.toggleDeafen());
  } else if (k === "x") {
    act("disconnect", bridge.disconnectVoice());
  } else if (k === "c") {
    bridge
      .listVoiceChannels()
      .then((channels) => {
        if (!channels) {
          console.log("[couchcord] No guild known yet — join a voice channel once first");
          return;
        }
        lastChannels = channels;
        channels.forEach((c, i) => console.log(`    ${i + 1}. ${c.name}${c.current ? "  (current)" : ""}`));
      })
      .catch((err) => console.log(`[couchcord] channel list failed: ${err.message}`));
  } else if (str && /^[1-9]$/.test(str)) {
    const target = lastChannels[Number(str) - 1];
    if (target) act(`join ${target.name}`, bridge.joinVoiceChannel(target.id));
  }
});
