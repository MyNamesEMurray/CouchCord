"use strict";

const { EventEmitter } = require("node:events");

// SDL normalizes every pad to the Xbox layout, so these names are positional:
// "a" is always the south button, "b" the east button — a Nintendo pad's
// physical B/A. We navigate by position, and the UI shows the matching label.
const NAV_BUTTONS = {
  dpadUp: "up",
  dpadDown: "down",
  dpadLeft: "left",
  dpadRight: "right",
  a: "accept",
  b: "back",
};
const REPEATABLE = new Set(["up", "down", "left", "right"]);
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 130;
// "Learn" mode: the combo the user holds steady this long becomes the chord.
const CAPTURE_HOLD_MS = 1000;

// Glyph family for button hints, from SDL's controller type detection.
function familyOf(device) {
  const t = device.type || "";
  if (t.startsWith("ps")) return "playstation";
  if (t.startsWith("nintendo")) return "nintendo";
  if (t.startsWith("xbox")) return "xbox";
  const n = (device.name || "").toLowerCase();
  if (/dualshock|dualsense|playstation/.test(n)) return "playstation";
  if (/switch|joy-?con|nintendo/.test(n)) return "nintendo";
  return "xbox"; // generic pads follow the Xbox layout under SDL
}

// Polls game controllers via SDL from the main process, so input keeps
// flowing while the game has focus (requires the
// SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS hint, set in main.js before load).
// Emits:
//   "chord"             – summon chord held for chordHoldMs
//   "nav" (action)      – up/down/left/right/accept/back, with d-pad repeat
//   "activity" (family) – any press; family of the most recently active pad
//   "log" (line)
class ControllerInput extends EventEmitter {
  constructor({ chord, chordHoldMs }) {
    super();
    this.chord = chord;
    this.chordHoldMs = chordHoldMs;
    this.activeFamily = "xbox";
    this._sdl = null;
    this._pads = new Map(); // SDL device id -> pad record
    this._capture = null; // { timer } while learn mode is active
  }

  // ---- chord learn mode -----------------------------------------------------
  // While capturing, all buttons feed the capture instead of chord/nav. When
  // a non-empty combo is held steady for CAPTURE_HOLD_MS it becomes the new
  // chord ("chordCaptured" event); "captureUpdate" streams the held buttons
  // for the UI.

  startCapture() {
    this.cancelCapture();
    this._capture = { timer: null };
    for (const pad of this._pads.values()) {
      clearTimeout(pad.chordTimer);
      pad.chordTimer = null;
      pad.chordLatched = false;
      this._stopRepeat(pad);
    }
    this.emit("captureUpdate", []);
  }

  cancelCapture() {
    if (!this._capture) return;
    clearTimeout(this._capture.timer);
    this._capture = null;
  }

  setChord(chord) {
    this.chord = chord;
  }

  _captureTick(pad) {
    const held = [...pad.pressed].sort();
    clearTimeout(this._capture.timer);
    this.emit("captureUpdate", held);
    if (!held.length) return;
    this._capture.timer = setTimeout(() => {
      this._capture = null;
      // Holding ONLY the east button (B/○ — "back" everywhere else in the
      // UI) cancels instead of capturing; a solo east-button chord would be
      // unusable anyway.
      if (held.length === 1 && held[0] === "b") {
        this.emit("captureCancelled");
        return;
      }
      this.chord = held;
      pad.chordLatched = true; // don't fire the new chord from this same hold
      this.emit("chordCaptured", held);
    }, CAPTURE_HOLD_MS);
  }

  start() {
    try {
      this._sdl = require("@kmamal/sdl");
      for (const device of this._sdl.controller.devices) this._open(device);
      // Hot-plug: pads may connect/disconnect at any time.
      this._sdl.controller.on("deviceAdd", ({ device }) => this._open(device));
      this._sdl.controller.on("deviceRemove", ({ device }) => {
        const pad = this._pads.get(device.id);
        if (pad && !pad.inst.closed) {
          try {
            pad.inst.close();
          } catch {}
        }
        this._cleanup(device.id);
      });
    } catch (err) {
      this._log(`SDL failed to start — controller input disabled (${err.message})`);
      return;
    }
    if (this._pads.size === 0) this._log("No controller detected yet — plug one in any time");
  }

  _open(device) {
    if (this._pads.has(device.id)) return;
    let inst;
    try {
      inst = this._sdl.controller.openDevice(device);
    } catch (err) {
      this._log(`Could not open ${device.name}: ${err.message}`);
      return;
    }
    const pad = {
      id: device.id,
      inst,
      family: familyOf(device),
      pressed: new Set(),
      chordTimer: null,
      chordLatched: false,
      repeat: null,
    };
    this._pads.set(device.id, pad);
    this._log(`Controller connected: ${device.name} (${pad.family} layout)`);
    inst.on("buttonDown", ({ button }) => this._buttonDown(pad, button));
    inst.on("buttonUp", ({ button }) => this._buttonUp(pad, button));
    inst.on("close", () => this._cleanup(device.id));
  }

  _cleanup(id) {
    const pad = this._pads.get(id);
    if (!pad) return;
    clearTimeout(pad.chordTimer);
    this._stopRepeat(pad);
    this._pads.delete(id);
    this._log("Controller disconnected");
  }

  _buttonDown(pad, button) {
    pad.pressed.add(button);
    // Most recently active pad wins: its layout drives the button hints.
    // ponytail: nav events are accepted from every pad; if two people mash
    // at once, filter here on pad.id === lastActive pad's id.
    if (pad.family !== this.activeFamily) {
      this.activeFamily = pad.family;
    }
    this.emit("activity", pad.family);

    if (this._capture) {
      this._captureTick(pad);
      return;
    }

    if (this.chord.includes(button)) {
      const held = this.chord.every((b) => pad.pressed.has(b));
      if (held && !pad.chordTimer && !pad.chordLatched) {
        pad.chordTimer = setTimeout(() => {
          pad.chordTimer = null;
          pad.chordLatched = true; // no re-fire until the chord is fully released
          this.emit("chord");
        }, this.chordHoldMs);
      }
      return;
    }

    const action = NAV_BUTTONS[button];
    if (!action) return;
    this.emit("nav", action);
    if (REPEATABLE.has(action)) {
      this._stopRepeat(pad);
      pad.repeat = {
        button,
        delay: setTimeout(() => {
          pad.repeat.interval = setInterval(() => this.emit("nav", action), REPEAT_INTERVAL_MS);
        }, REPEAT_DELAY_MS),
      };
    }
  }

  _buttonUp(pad, button) {
    pad.pressed.delete(button);
    if (this._capture) {
      this._captureTick(pad);
      return;
    }
    if (this.chord.includes(button)) {
      clearTimeout(pad.chordTimer);
      pad.chordTimer = null;
      if (!this.chord.some((b) => pad.pressed.has(b))) pad.chordLatched = false;
    }
    if (pad.repeat && pad.repeat.button === button) this._stopRepeat(pad);
  }

  _stopRepeat(pad) {
    if (!pad.repeat) return;
    clearTimeout(pad.repeat.delay);
    clearInterval(pad.repeat.interval);
    pad.repeat = null;
  }

  _log(line) {
    this.emit("log", line);
  }
}

module.exports = { ControllerInput };
