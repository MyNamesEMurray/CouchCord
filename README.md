# CouchCord

A controller-summoned Discord voice overlay for couch gaming on a Windows HTPC.

Games run borderless-fullscreen from Steam Big Picture; Discord runs in the
background. CouchCord floats a small HUD in a corner showing who's in your
voice channel and who's talking. Hold **Back + Start** on the controller and a
10-foot panel pops up where you can mute, deafen, switch voice channels, or
disconnect — then it gets out of the way and the game gets your controller
back.

CouchCord is a **companion to the running Discord desktop app, not a Discord
client**. It talks to Discord over the local RPC (IPC) pipe — the same
mechanism Discord StreamKit uses. It never touches your user token and never
calls the Discord HTTP API on your behalf.

## Status

Phase 2 (passive HUD) is done: `npm start` floats a click-through,
always-on-top corner HUD showing voice channel members with live speaking
indicators. It appears when you join voice and hides when you leave.
Controller summon + the interactive panel come in later phases.
`npm run spike` (Phase 1) remains as a console debugging tool.

## Requirements

- Windows 10/11 (the spike also runs anywhere the Discord desktop app runs)
- [Node.js](https://nodejs.org) 20+
- Discord desktop app, running and logged in

## Discord setup (one time, ~2 minutes)

CouchCord needs a Discord *application* identity to open an RPC connection.
You create your own — it's personal, free, and stays on your machine:

1. Go to <https://discord.com/developers/applications> and click
   **New Application**. Name it anything (e.g. `CouchCord`).
2. On the **OAuth2** page, copy the **Client ID** and **Client Secret**.
3. `npm install`, then run `npm run spike` once — it creates `config.json`.
4. Paste both values into `config.json` (`clientId`, `clientSecret`).
5. Run `npm run spike` again. Discord pops an authorization dialog —
   click **Authorize**. That's it; the grant is cached in `token.json` so
   you won't be asked again.

> **Why this works without Discord's approval:** RPC apps normally need
> Discord to whitelist them, but an unapproved app is always allowed to RPC
> for **the account that owns the app**. You own this app, so it works for
> you — exactly right for personal use.

`config.json` and `token.json` are gitignored; the client secret is only ever
sent to Discord itself during the local OAuth exchange.

## Running the spike

```
npm run spike
```

Join a voice channel in Discord and watch join/leave/speaking events stream
by. Keys: `m` toggle mute · `d` toggle deafen · `c` list voice channels ·
`1`–`9` join a listed channel · `x` disconnect · `q` quit.
