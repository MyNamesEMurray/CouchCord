# CouchCord

A controller-summoned Discord voice overlay for couch gaming on a Windows
HTPC.

Games run borderless-fullscreen from Steam Big Picture; Discord runs in the
background. CouchCord floats a small click-through HUD in a corner showing
who's in your voice channel and who's talking. Hold **Back + Start**
(View + Menu) on the controller for about half a second and a 10-foot panel
pops up: mute, deafen, switch voice channels, or disconnect — all with the
d-pad. Close it and the game gets your controller back.

CouchCord is a **companion to the running Discord desktop app, not a Discord
client**. It talks to Discord over the local RPC (IPC) pipe — the same
mechanism Discord StreamKit and Discover Overlay use. It never touches your
user token and never calls the Discord HTTP API on your behalf.

## Requirements

- Windows 10/11 (development also works on Linux/macOS wherever the Discord
  desktop app runs)
- [Node.js](https://nodejs.org) 20+
- Discord desktop app, running and logged in
- A game controller: Xbox (XInput), PlayStation (DualShock 4 / DualSense),
  Nintendo Switch Pro, or most generic pads — SDL's controller database
  normalizes them all to one layout. One pad drives the UI at a time; the
  most recently used one wins.

## Discord setup (one time, ~2 minutes)

CouchCord needs a Discord *application* identity to open an RPC connection.
You create your own — it's personal, free, and stays on your machine:

1. Go to <https://discord.com/developers/applications> and click
   **New Application**. Name it anything (e.g. `CouchCord`).
2. On the **OAuth2** page, copy the **Client ID** and the **Client Secret**.
3. Run `npm install`, then `npm start` once — it creates `config.json` and
   exits.
4. Paste both values into `config.json` (`clientId`, `clientSecret`).
5. Run `npm start` again. Discord pops an authorization dialog — click
   **Authorize**. The grant is cached in `token.json`, so this only happens
   once.

> **Why this works without Discord's approval:** RPC apps normally need to
> be whitelisted by Discord, but an unapproved app is always allowed to RPC
> for **the account that owns the app**. You own this app, so it works for
> you — exactly right for personal use.

`config.json` and `token.json` are gitignored. The client secret is only
ever sent to Discord itself during the local OAuth code exchange.

## Running

```
npm start        # the overlay
npm run spike    # console-only RPC test harness (Phase 1), handy for debugging
```

Join a voice channel in Discord and the HUD appears in the configured
corner. It hides automatically when you leave voice.

For quick tests without a controller: **F10** toggles the panel, and while
it is open the arrow keys / Enter / Escape mirror the d-pad / A / B.

## Controls

| Input | Effect |
| --- | --- |
| Hold **Back + Start** ~400 ms | Open / close the panel (works while the game has focus) |
| **D-pad** | Move the focus ring (hold to repeat in lists) |
| **A** (south button) | Activate the focused button |
| **B** (east button) | Back / close the panel |

Buttons are **positional**, matching SDL's normalized layout: "A" always
means the south button, so a Nintendo pad's physical B activates — and the
on-screen hints switch to the matching labels (✕/○ on PlayStation, B/A on
Nintendo) for whichever pad you used last.

Panel actions: **Mute · Deafen · Disconnect · Voice Channels · Hide HUD ·
Quit CouchCord**. The channel switcher lists the current server's voice
channels (the last server is remembered, so you can disconnect and rejoin
from the couch).

While the panel is open it takes keyboard/controller focus, so Steam Input
stops routing your pad to the game; closing it hands focus straight back.

## config.json

Created from `config.example.json` on first run.

| Key | Default | Meaning |
| --- | --- | --- |
| `clientId` / `clientSecret` | `""` | Your Discord application credentials (see above) |
| `chord` | `["back", "start"]` | Buttons that summon the panel. SDL names: `a b x y back start guide leftShoulder rightShoulder leftStick rightStick dpadUp dpadDown dpadLeft dpadRight` |
| `chordHoldMs` | `400` | How long the chord must be held |
| `hudCorner` | `"top-right"` | `top-left`, `top-right`, `bottom-left`, `bottom-right` |
| `hudScale` | `1.0` | Scales the whole UI (try `1.5` for a far couch) |
| `debugHotkey` | `"F10"` | Global keyboard shortcut to toggle the panel; `""` disables |
| `launchOnLogin` | `false` | Start CouchCord when Windows logs in |

## Limitations (by design)

- **Borderless / windowed games only.** Exclusive-fullscreen games bypass
  the desktop compositor, so no overlay window can appear above them without
  DLL injection or game hooking — which CouchCord deliberately does not do.
  Set the game to *borderless fullscreen* (the default for most modern
  titles and for Big Picture use).
- The RPC connection works for the Discord account that owns the app ID —
  personal use, not distribution.
- One guild at a time: the channel switcher shows the server you're (or were
  last) connected to.
- Very exotic pads that SDL's controller database doesn't know stay
  invisible to CouchCord.
- No text chat, no notifications, no settings UI — `config.json` is the
  settings UI.

## Troubleshooting

- **"Discord not reachable … retrying"** — start the Discord desktop app
  (not the browser client). CouchCord reconnects by itself, including after
  Discord restarts or updates.
- **Authorization popup again?** Delete `token.json` if auth ever gets
  stuck; declining the popup stops CouchCord until you restart it.
- **HUD doesn't show over the game** — the game is in exclusive fullscreen;
  switch it to borderless (see Limitations).
- **Chord does nothing** — check the pad works elsewhere; try `npm run
  spike` to isolate Discord issues from controller issues; the console log
  lists every controller connect/disconnect.
- **Panel opened but the game still gets input** — that's Steam Input
  routing to whichever window has focus; if focus didn't move, click once or
  report the game — the focus grab is `win.focus()` on an always-on-top
  window and can lose to some anti-cheat titles.

## Acceptance walkthrough

With Discord in a voice call and a game running borderless-fullscreen from
Big Picture:

1. HUD sits in the corner, speaking rings light up as people talk.
2. Hold Back + Start → panel opens, game stops seeing the pad.
3. Mute → HUD shows 🔇; Unmute; Deafen → 🙉; Undeafen.
4. Voice Channels → pick another channel with the d-pad → A joins it.
5. Disconnect → HUD hides. Panel → Voice Channels still lists the server →
   rejoin.
6. B closes the panel → the game receives controller input again.

## Development notes

- `npm run spike` is the Phase 1 console harness: streams the same RPC
  events and drives mute/deafen/join from keypresses.
- Main-process modules: `src/discord.js` (RPC bridge + reconnect),
  `src/controller.js` (SDL polling, chord, hot-plug), `main.js` (window
  states + wiring). Renderer: `overlay/`.
- Deliberate shortcuts are marked with `ponytail:` comments noting the
  upgrade path.
