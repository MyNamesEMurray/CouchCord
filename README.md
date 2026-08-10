<p align="center">
  <img src="assets/banner.png" alt="CouchCord — Discord voice, from the couch." width="760">
</p>

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
You create your own — it's personal, free, and stays on your machine.

**The app walks you through it**: on first launch (no credentials yet)
CouchCord opens a setup screen with a button to the Discord Developer
Portal and paste boxes for the two values — no file editing needed. The
steps it guides you through:

1. Go to <https://discord.com/developers/applications> (signed in as the
   **same account your Discord desktop app uses**) and click
   **New Application**. Name it anything (e.g. `CouchCord`).
2. On the **OAuth2** page, under **Redirects**, click **Add Redirect**,
   enter exactly `http://127.0.0.1`, and **Save Changes**. (Discord
   requires a registered redirect for the authorization handshake.)
3. Still on **OAuth2**: copy the **Client ID** and the **Client Secret**
   (click **Reset Secret** if it's hidden).
4. Paste both into the setup screen and hit **Save & Start**.
5. CouchCord restarts; Discord pops an authorization dialog — click
   **Authorize**. The grant is cached in `token.json`, so this only happens
   once.

Prefer doing it by hand (or setting up the `npm run spike` harness)? Edit
`config.json` directly — same two fields (`clientId`, `clientSecret`).

> **Why this works without Discord's approval:** RPC apps normally need to
> be whitelisted by Discord, but an unapproved app is always allowed to RPC
> for **the account that owns the app**. You own this app, so it works for
> you — exactly right for personal use.

`config.json` and `token.json` are gitignored. The client secret is only
ever sent to Discord itself during the local OAuth code exchange.

## Running

```
npm start        # the overlay (from a checkout)
npm run spike    # console-only RPC test harness (Phase 1), handy for debugging
```

Where `config.json` and the cached `token.json` live depends on how you run:

- **From a checkout** (`npm start` / `npm run spike`): the repo root.
- **Installed build**: `%APPDATA%\CouchCord` on Windows. The first-run
  setup screen shows the exact path it saves to.

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

Panel actions: **Mute · Deafen · Disconnect · Voice Channels · Settings ·
Quit CouchCord**. **Voice Channels** first lists every server you're a
member of (with server icons; the one you're connected to is tagged and
pre-focused), then that server's voice channels — so you can hop to any
channel on any of your servers, or disconnect and rejoin, without touching
a keyboard.

**Settings** edits the config from the couch — every row cycles with **A**
and persists to `config.json` immediately:

- **Summon chord** — a learn mode: hold the button combo you want, keep it
  held for one second, and it becomes the chord (active immediately, no
  restart; the panel footer always shows the current chord). Holding
  **B/○ alone** cancels, as does Esc; learn mode times out after 20 s.
- **Chord hold time** (250–800 ms), **HUD corner**, **overlay size**
  (80–200 %), **show HUD in voice**, **HUD avatars** (on/off), **HUD
  shows** (everyone / only speakers), **HUD opacity** (50–95 %, HUD only —
  the interactive panel stays opaque for readability), and **launch on
  login**.

While the panel is open it takes keyboard/controller focus, so Steam Input
stops routing your pad to the game; closing it hands focus straight back.

## config.json

Created from `config.example.json` on first run.

| Key | Default | Meaning |
| --- | --- | --- |
| `clientId` / `clientSecret` | `""` | Your Discord application credentials (see above) |
| `chord` | `["back", "start"]` | Buttons that summon the panel — easiest set via the panel's **Remap Chord** learn mode. SDL names: `a b x y back start guide leftShoulder rightShoulder leftStick rightStick dpadUp dpadDown dpadLeft dpadRight` |
| `chordHoldMs` | `400` | How long the chord must be held |
| `hudCorner` | `"top-right"` | `top-left`, `top-right`, `bottom-left`, `bottom-right` |
| `hudScale` | `1.0` | Scales the whole UI (try `1.5` for a far couch) |
| `hudOpacity` | `0.85` | HUD card background opacity (the panel is unaffected) |
| `hudAvatars` | `true` | Show avatars in the HUD (`false` = names only, tighter rows) |
| `hudOnlySpeakers` | `false` | `true` shows only who's currently talking (HUD hides when quiet) |
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
- Very exotic pads that SDL's controller database doesn't know stay
  invisible to CouchCord.
- CouchCord can't turn Discord's own in-game overlay on or off — Discord
  exposes no API for that setting. If you don't want both overlays showing
  voice info, disable Discord's once under **User Settings → Game Overlay**
  (it stays off). They don't otherwise conflict — Discord's overlay injects
  into the game, CouchCord floats above it.
- No text chat and no notifications.

## Troubleshooting

- **"Discord not reachable … retrying"** — start the Discord desktop app
  (not the browser client). CouchCord reconnects by itself, including after
  Discord restarts or updates.
- **"Discord authorization failed"** — the usual causes, in order:
  1. `invalid_request: missing "redirect_uri"`: your Discord application
     has **no Redirect URI registered** — add exactly `http://127.0.0.1`
     under OAuth2 → Redirects and save. (Discord requires the app to have
     one registered even though the RPC flow never uses it directly.)
  2. The Discord desktop app is logged into a **different account** than
     the one that owns your Discord application (they must match).
  3. The **Client Secret** was pasted wrong (use Reset Secret on the
     OAuth2 page and copy the new value — the error dialog's *Redo setup*
     button reopens the wizard).
  CouchCord asks for authorization at most once per run, so it will never
  loop the popup.
- **Where's the UI after setup?** After the first successful authorization
  the panel opens by itself. From then on the HUD only appears while you're
  in a voice channel — that's normal.
- **Reporting a problem?** Every run writes `couchcord.log` next to
  `config.json` (`%APPDATA%\CouchCord` for installed builds, the repo root
  for checkouts) — paste it into an issue.
- Delete `token.json` if authorization ever gets stuck.
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
3. Mute → your row in the HUD shows 🔇; Unmute; Deafen → 🙉; Undeafen.
4. Voice Channels → pick a server, then a channel with the d-pad → A joins
   it (works across servers).
5. Disconnect → HUD hides. Panel → Voice Channels → rejoin.
6. B closes the panel → the game receives controller input again.

## Packaging a Windows build

```
npm run dist     # on Windows: dist/CouchCord-Setup-<version>.exe (NSIS installer)
npm run pack     # unpacked build in dist/ for quick testing, any platform
```

electron-builder is already configured in `package.json` (`build` section):
the installer embeds `assets/icon.ico`, ships only the runtime files, keeps
SDL's native binaries outside the asar so they load, and skips the native
rebuild step (both dependencies are prebuilt/pure JS). The installer is
per-user — no admin prompt — and installed builds keep their settings in
`%APPDATA%\CouchCord`.

The build is unsigned; Windows SmartScreen will warn on first run of a
downloaded installer ("More info" → "Run anyway"). Code signing is a
paid-certificate step you can add later via electron-builder's `win.sign*`
options.

**Releases build themselves**: pushing a `v*` tag runs
`.github/workflows/release.yml`, which builds the installer on a Windows
runner, creates the GitHub release (using `release-notes/<tag>.md` when
present, generated notes otherwise), and attaches
`CouchCord-Setup-<version>.exe`. Publishing a release by hand triggers the
same build. The job fails early if the tag doesn't match the
`package.json` version — the flow is:

```
npm version 0.2.0 --no-git-tag-version
git commit -am "v0.2.0" && git tag v0.2.0 && git push && git push --tags
```

You can also run the workflow manually from the Actions tab to get the
installer as a downloadable artifact without cutting a release.

## Brand

The mark is the **Speaking Couch**: a coral couch with mint voice arcs —
voice chat, from the sofa. Masters live in `assets/` (`logo.svg` is the
transparent mark, `icon.svg` the tiled app icon); `npm run assets`
regenerates `icon.png`, `icon.ico` (16–256 px, Windows-ready) and
`banner.png` from them using Electron as the rasterizer — no extra tooling.

| Token | Hex | Use |
| --- | --- | --- |
| Couch Coral | `#FF6B4A` | Mark, focus ring, accents, "Cord" in the wordmark |
| Live Mint | `#2FD98C` | Speaking indicators, connected states, voice arcs |
| Midnight | `#121631` → `#1E2447` | Icon tile / brand backgrounds |
| Panel Night | `#11131B` | In-app surfaces |
| Cream | `#F5EFE6` | Wordmark "Couch", titles on dark |
| Danger Red | `#F23F43` | Disconnect/quit accents, mute flags |

Wordmark: **Nunito Black**, tight tracking, two-tone (`Couch` cream, `Cord`
coral). Nunito is bundled in `assets/fonts/` under the SIL Open Font
License. Tagline: *"Discord voice, from the couch."*

Intentionally distinct from Discord's own branding: no blurple, no Clyde,
no Discord logo anywhere. When publishing, keep it that way — and keep the
disclaimer below.

> CouchCord is an unofficial companion app. It is not affiliated with,
> endorsed by, or sponsored by Discord Inc. "Discord" is a trademark of
> Discord Inc.

## Development notes

- `npm run spike` is the Phase 1 console harness: streams the same RPC
  events and drives mute/deafen/join from keypresses.
- Main-process modules: `src/discord.js` (RPC bridge + reconnect),
  `src/controller.js` (SDL polling, chord, hot-plug), `main.js` (window
  states + wiring). Renderer: `overlay/`.
- Deliberate shortcuts are marked with `ponytail:` comments noting the
  upgrade path.
