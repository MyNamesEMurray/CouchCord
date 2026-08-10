"use strict";

const { EventEmitter } = require("node:events");
const { Client } = require("@xhayper/discord-rpc");
const { FramingFixedIPCTransport } = require("./ipc-fix");

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

// Discord's RPC authorization has a quirky pair of requirements (both
// observed in the field, August 2026):
//   - the APPLICATION must have at least one Redirect URI registered, or
//     AUTHORIZE fails with 'invalid_request: missing "redirect_uri"';
//   - but the AUTHORIZE request itself must NOT include a redirect_uri, or
//     it fails with 'Redirect URI cannot be used in the RPC OAuth2
//     Authorization flow'.
// So the setup docs have users register http://127.0.0.1 on the app, and we
// omit the parameter everywhere — including the token exchange, matching the
// classic RPC flow.
// Env override exists for the offline test harness only.
const TOKEN_URL = process.env.COUCHCORD_OAUTH_URL || "https://discord.com/api/oauth2/token";

// Any RPC request that gets no answer within this window is treated as
// failed — a stalled pipe must surface as an error, never as a hang.
const REQUEST_TIMEOUT_MS = 10000;

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), REQUEST_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

// Errors from @discordjs/rest carry the useful part in rawError; RPC errors
// in code/message. Flatten whatever we got into one loggable line.
function describeError(err) {
  if (!err) return "unknown error";
  const code = err.code !== undefined && err.code !== null ? ` [code ${err.code}]` : "";
  const raw = err.rawError ? ` ${JSON.stringify(err.rawError)}` : "";
  return `${err.message || String(err)}${code}${raw}`;
}

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
    this.fatalError = null; // set when interactive authorization failed — no more retries
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
  }

  start() {
    this._connectSoon(0);
  }

  async stop() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    const client = this._client;
    this._client = null;
    if (client) await client.destroy().catch(() => {});
  }

  snapshot() {
    return {
      connected: this.connected,
      fatalError: this.fatalError,
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

  // Every guild the logged-in user is a member of. Icon URLs are passed
  // through only when they point at Discord's CDN (the renderer's CSP only
  // allows images from there anyway).
  async listGuilds() {
    const data = await this._req("GET_GUILDS");
    return (data.guilds || []).map((g) => ({
      id: g.id,
      name: g.name,
      iconUrl: typeof g.icon_url === "string" && g.icon_url.startsWith("https://cdn.discordapp.com/") ? g.icon_url : null,
    }));
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
    if (this._stopped || this.fatalError) return;
    this._connectSoon(this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, RETRY_MAX_MS);
  }

  // OAuth token grants, done with fetch instead of the RPC library's REST
  // internals: gives us the exact Discord error on failure and lets us
  // persist the rotated refresh token right at the exchange. Saves the
  // refresh token as a side effect.
  async _fetchToken(params) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        ...params,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const err = new Error(`token exchange failed: ${data.error_description || data.error || `HTTP ${res.status}`}`);
      err.code = data.error || res.status;
      throw err;
    }
    if (data.refresh_token && this.tokenStore) this.tokenStore.save(data.refresh_token);
    return data.access_token;
  }

  async _connect() {
    if (this._stopped) return;

    // Refresh a cached grant first — pure HTTPS, no popup, no client needed.
    const cached = this.tokenStore ? this.tokenStore.load() : null;
    let accessToken = null;
    if (cached) {
      try {
        accessToken = await this._fetchToken({ grant_type: "refresh_token", refresh_token: cached });
      } catch (err) {
        if (err.name === "TypeError" || /fetch failed/i.test(String(err.message))) {
          // Network problem, not a rejected grant — keep the token, try later.
          this._log(`Discord token refresh unreachable (${describeError(err)}); retrying in ${this._retryDelay / 1000}s`);
          this._scheduleRetry();
          return;
        }
        this._log(`Cached Discord authorization was rejected (${describeError(err)}); asking for a fresh one`);
        if (this.tokenStore) this.tokenStore.clear();
      }
    }

    const client = new Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      transport: { type: FramingFixedIPCTransport },
    });
    this._client = client;
    client.on("disconnected", () => this._onDisconnected(client));
    for (const evt of [...GLOBAL_EVENTS, ...CHANNEL_EVENTS]) {
      client.on(evt, (data) => {
        if (this._client === client) this._onEvent(evt, data);
      });
    }

    const teardown = async () => {
      if (this._client === client) this._client = null;
      await client.destroy().catch(() => {});
      this._resetVoiceState(); // a half-finished attempt must not leave stale state behind
    };

    let interactive = false;
    try {
      if (accessToken) {
        await client.login({ scopes: SCOPES, accessToken });
      } else {
        interactive = true;
        await client.connect();
        this._log("Asking Discord for authorization — watch for the popup in Discord");
        const res = await client.request("AUTHORIZE", {
          scopes: SCOPES,
          client_id: this.clientId,
          prompt: "consent",
        });
        const code = res && res.data ? res.data.code : null;
        if (!code) throw new Error("Discord authorization returned no code");
        accessToken = await this._fetchToken({
          grant_type: "authorization_code",
          code,
        });
        await client.login({ scopes: SCOPES, accessToken });
      }
    } catch (err) {
      const reachedDiscord = client.isConnected;
      await teardown();
      if (!reachedDiscord) {
        // Discord isn't running (or its pipe is gone) — keep waiting for it.
        this._log(`Discord not reachable (${describeError(err)}); retrying in ${this._retryDelay / 1000}s`);
        this._emitUpdate();
        this._scheduleRetry();
        return;
      }
      if (!interactive) {
        // A refreshed token was rejected at AUTHENTICATE — distrust the
        // grant and go interactive once.
        this._log(`Cached Discord authorization was rejected (${describeError(err)}); asking for a fresh one`);
        if (this.tokenStore) this.tokenStore.clear();
        this._emitUpdate();
        this._connectSoon(1000);
        return;
      }
      // Interactive authorization failed. Do NOT retry: every retry re-opens
      // the Authorize popup, which loops forever when something is wrong
      // (missing redirect URI, wrong secret, Discord logged into an account
      // that doesn't own the app, ...). Surface it and stop.
      this.fatalError = describeError(err);
      this._log(`Discord authorization failed: ${this.fatalError}`);
      this._emitUpdate();
      this.emit("fatal", this.fatalError);
      return;
    }

    try {
      this._retryDelay = RETRY_MIN_MS;
      this.connected = true;
      this.userId = client.user ? client.user.id : null;
      await this._subscribeAll();
      this._log(`Connected to Discord as ${client.user ? client.user.username : "unknown"}`);
      this._emitUpdate();
      if (interactive) this.emit("authorized"); // fresh grant — let the UI show itself
    } catch (err) {
      // Authenticated fine but the initial subscribes/queries failed — the
      // grant is cached now, so a plain retry is safe (no popup involved).
      await teardown();
      this._log(`Discord session setup failed (${describeError(err)}); retrying in ${this._retryDelay / 1000}s`);
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
    for (const evt of GLOBAL_EVENTS) await withTimeout(this._client.subscribe(evt), `subscribe ${evt}`);
    const settings = await this._req("GET_VOICE_SETTINGS");
    this.self = { mute: !!settings.mute, deaf: !!settings.deaf };
    await this._refreshChannel();
  }

  _onDisconnected(client) {
    if (this._client !== client) return; // stale client from a torn-down attempt
    this._client = null;
    this._resetVoiceState();
    client.destroy().catch(() => {});
    this._log("Discord went away; waiting for it to come back");
    this._emitUpdate();
    this._retryDelay = RETRY_MIN_MS;
    this._scheduleRetry();
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
          this._channelSubs.push(await withTimeout(client.subscribe(evt, { channel_id: channel.id }), `subscribe ${evt}`));
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
    const res = await withTimeout(this._client.request(cmd, args), cmd);
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
