"use strict";

const { EventEmitter } = require("node:events");
const { Client } = require("@xhayper/discord-rpc");

// Scopes: `rpc` for guild/channel listing, `rpc.voice.read` for voice state +
// speaking events, `rpc.voice.write` for mute/deafen/channel commands.
// Unapproved apps get these scopes only for the account that owns the app.
const SCOPES = ["rpc", "rpc.voice.read", "rpc.voice.write"];

const CHANNEL_EVENTS = [
  "VOICE_STATE_CREATE",
  "VOICE_STATE_UPDATE",
  "VOICE_STATE_DELETE",
  "SPEAKING_START",
  "SPEAKING_STOP",
];
const GLOBAL_EVENTS = ["VOICE_CHANNEL_SELECT", "VOICE_SETTINGS_UPDATE"];
const GUILD_VOICE = 2; // channel type

const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;
const TOKEN_SAVE_INTERVAL_MS = 60000;

// Talks to the already-running Discord desktop client over its local RPC (IPC)
// pipe — CouchCord is a companion, not a Discord client. Emits:
//   "update"          – voice state changed; call snapshot() for the new state
//   "event" (evt, d)  – raw RPC dispatch, for spike/debug logging
//   "log" (line)      – human-readable connection progress
class DiscordBridge extends EventEmitter {
  constructor({ clientId, clientSecret, tokenStore }) {
    super();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenStore = tokenStore;

    this.connected = false;
    this.authDeclined = false;
    this.userId = null;
    this.channel = null; // { id, name, guildId }
    this.lastGuildId = null; // survives disconnect so we can rejoin
    this.members = new Map(); // user id -> member
    this.speaking = new Set(); // user ids
    this.self = { mute: false, deaf: false };

    this._client = null;
    this._stopped = false;
    this._retryTimer = null;
    this._retryDelay = RETRY_MIN_MS;
    this._channelSubs = [];
    this._channelOp = Promise.resolve(); // serializes channel (re)subscribes
    this._tokenTimer = null;
    this._savedToken = null;
  }

  start() {
    this._connectSoon(0);
  }

  async stop() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._tokenTimer);
    this._saveTokenIfRotated();
    const client = this._client;
    this._client = null;
    if (client) await client.destroy().catch(() => {});
  }

  snapshot() {
    return {
      connected: this.connected,
      authDeclined: this.authDeclined,
      channel: this.channel ? { ...this.channel } : null,
      lastGuildId: this.lastGuildId, // lets the server picker preselect sensibly

      self: { ...this.self },
      members: [...this.members.values()]
        .map((m) => ({
          ...m,
          speaking: this.speaking.has(m.id),
          self: m.id === this.userId,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // ---- voice commands -------------------------------------------------------

  async toggleMute() {
    const s = await this._req("GET_VOICE_SETTINGS");
    // Mirror the Discord mic button: while deafened it undeafens + unmutes.
    if (s.deaf) await this._req("SET_VOICE_SETTINGS", { deaf: false, mute: false });
    else await this._req("SET_VOICE_SETTINGS", { mute: !s.mute });
  }

  async toggleDeafen() {
    const s = await this._req("GET_VOICE_SETTINGS");
    await this._req("SET_VOICE_SETTINGS", { deaf: !s.deaf });
  }

  async disconnectVoice() {
    await this._req("SELECT_VOICE_CHANNEL", { channel_id: null, force: true });
  }

  async joinVoiceChannel(channelId) {
    await this._req("SELECT_VOICE_CHANNEL", { channel_id: channelId, force: true });
  }

  // Every guild the logged-in user is a member of.
  async listGuilds() {
    const data = await this._req("GET_GUILDS");
    return (data.guilds || []).map((g) => ({ id: g.id, name: g.name }));
  }

  // Voice channels of the given guild — or, with no argument, the current one
  // (falling back to the last one we were in, so disconnect -> reconnect
  // works). Returns null when no guild can be determined.
  async listVoiceChannels(guildId) {
    const target = guildId || (this.channel && this.channel.guildId) || this.lastGuildId;
    if (!target) return null;
    const data = await this._req("GET_CHANNELS", { guild_id: target });
    return (data.channels || [])
      .filter((c) => c.type === GUILD_VOICE)
      .map((c) => ({ id: c.id, name: c.name, current: !!this.channel && c.id === this.channel.id }));
  }

  // ---- connection lifecycle -------------------------------------------------

  _connectSoon(ms) {
    if (this._stopped || this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect();
    }, ms);
  }

  _scheduleRetry() {
    if (this._stopped || this.authDeclined) return;
    this._connectSoon(this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, RETRY_MAX_MS);
  }

  async _connect() {
    if (this._stopped) return;
    const client = new Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      transport: { type: "ipc" },
    });
    this._client = client;
    client.on("disconnected", () => this._onDisconnected(client));
    for (const evt of [...GLOBAL_EVENTS, ...CHANNEL_EVENTS]) {
      client.on(evt, (data) => {
        if (this._client === client) this._onEvent(evt, data);
      });
    }

    try {
      const cached = this.tokenStore ? this.tokenStore.load() : null;
      if (!cached) this._log("Connecting to Discord — approve the authorization popup in Discord (first run only)");
      try {
        await client.login(cached ? { scopes: SCOPES, refreshToken: cached } : { scopes: SCOPES });
      } catch (err) {
        // Only distrust the cached token when we actually reached Discord —
        // a dead pipe (Discord not running) says nothing about the token.
        if (cached && client.isConnected) {
          this._log("Cached Discord authorization was rejected; will ask again");
          if (this.tokenStore) this.tokenStore.clear();
        }
        if (/denied|declin/i.test(String(err && err.message))) {
          this.authDeclined = true;
          this._log("Authorization was declined in Discord. Restart CouchCord to try again.");
          this._emitUpdate();
        }
        throw err;
      }

      this._retryDelay = RETRY_MIN_MS;
      this.connected = true;
      this.userId = client.user ? client.user.id : null;
      this._saveTokenIfRotated();
      this._tokenTimer = setInterval(() => this._saveTokenIfRotated(), TOKEN_SAVE_INTERVAL_MS);
      await this._subscribeAll();
      this._log(`Connected to Discord as ${client.user ? client.user.username : "unknown"}`);
      this._emitUpdate();
    } catch (err) {
      if (this._client === client) this._client = null;
      await client.destroy().catch(() => {});
      this._resetVoiceState(); // a half-finished attempt must not leave stale state behind
      if (!this.authDeclined) this._log(`Discord not reachable (${err && err.message ? err.message : err}); retrying in ${this._retryDelay / 1000}s`);
      this._emitUpdate();
      this._scheduleRetry();
    }
  }

  _resetVoiceState() {
    this.connected = false;
    this.channel = null;
    this.members.clear();
    this.speaking.clear();
    this._channelSubs = [];
  }

  async _subscribeAll() {
    for (const evt of GLOBAL_EVENTS) await this._client.subscribe(evt);
    const settings = await this._req("GET_VOICE_SETTINGS");
    this.self = { mute: !!settings.mute, deaf: !!settings.deaf };
    await this._refreshChannel();
  }

  _onDisconnected(client) {
    if (this._client !== client) return; // stale client from a torn-down attempt
    this._client = null;
    clearInterval(this._tokenTimer);
    this._resetVoiceState();
    client.destroy().catch(() => {});
    this._log("Discord went away; waiting for it to come back");
    this._emitUpdate();
    this._retryDelay = RETRY_MIN_MS;
    this._scheduleRetry();
  }

  // Discord rotates refresh tokens on every refresh; persist the latest so the
  // next launch can still authenticate silently.
  _saveTokenIfRotated() {
    const token = this._client ? this._client.refreshToken : null;
    if (token && token !== this._savedToken && this.tokenStore) {
      this.tokenStore.save(token);
      this._savedToken = token;
    }
  }

  // ---- voice state tracking -------------------------------------------------

  _onEvent(evt, data) {
    this.emit("event", evt, data);
    switch (evt) {
      case "VOICE_CHANNEL_SELECT":
        this._refreshChannel();
        break;
      case "VOICE_SETTINGS_UPDATE":
        if (data) {
          this.self = { mute: !!data.mute, deaf: !!data.deaf };
          this._emitUpdate();
        }
        break;
      case "VOICE_STATE_CREATE":
      case "VOICE_STATE_UPDATE":
        this._upsertMember(data);
        this._emitUpdate();
        break;
      case "VOICE_STATE_DELETE": {
        const id = data && data.user && data.user.id;
        if (id) {
          this.members.delete(id);
          this.speaking.delete(id);
          this._emitUpdate();
        }
        break;
      }
      case "SPEAKING_START":
        if (data && data.user_id) {
          this.speaking.add(data.user_id);
          this._emitUpdate();
        }
        break;
      case "SPEAKING_STOP":
        if (data && data.user_id) {
          this.speaking.delete(data.user_id);
          this._emitUpdate();
        }
        break;
    }
  }

  // Re-reads the selected voice channel and moves the per-channel event
  // subscriptions over to it. Serialized: SELECT events can arrive faster
  // than the subscribe round-trips complete.
  _refreshChannel() {
    this._channelOp = this._channelOp
      .then(async () => {
        const client = this._client;
        if (!client) return;
        const channel = await this._req("GET_SELECTED_VOICE_CHANNEL");
        for (const sub of this._channelSubs.splice(0)) {
          await Promise.resolve(sub.unsubscribe()).catch(() => {});
        }
        if (this._client !== client) return;
        this.members.clear();
        this.speaking.clear();
        if (!channel) {
          this.channel = null;
          this._emitUpdate();
          return;
        }
        this.channel = { id: channel.id, name: channel.name, guildId: channel.guild_id || null };
        if (channel.guild_id) this.lastGuildId = channel.guild_id;
        for (const evt of CHANNEL_EVENTS) {
          this._channelSubs.push(await client.subscribe(evt, { channel_id: channel.id }));
        }
        for (const vs of channel.voice_states || []) this._upsertMember(vs);
        this._emitUpdate();
      })
      .catch((err) => this._log(`Voice channel refresh failed: ${err && err.message ? err.message : err}`));
    return this._channelOp;
  }

  _upsertMember(vs) {
    const user = vs && vs.user;
    if (!user || !user.id) return;
    const flags = vs.voice_state || {};
    this.members.set(user.id, {
      id: user.id,
      name: vs.nick || user.global_name || user.username || "?",
      avatar: user.avatar || null,
      muted: !!(flags.mute || flags.self_mute || flags.suppress),
      deafened: !!(flags.deaf || flags.self_deaf),
    });
  }

  // ---- plumbing -------------------------------------------------------------

  async _req(cmd, args) {
    if (!this._client) throw new Error("not connected to Discord");
    const res = await this._client.request(cmd, args);
    return res && typeof res === "object" && "cmd" in res ? res.data : res;
  }

  _emitUpdate() {
    this.emit("update", this.snapshot());
  }

  _log(line) {
    this.emit("log", line);
  }
}

module.exports = { DiscordBridge };
