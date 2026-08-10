"use strict";

const api = window.couchcord;

const hud = document.getElementById("hud");
const hudChannel = document.getElementById("hud-channel");
const hudFlags = document.getElementById("hud-flags");
const hudMembers = document.getElementById("hud-members");

const panel = document.getElementById("panel");
const panelStatus = document.getElementById("panel-status");
const panelMembers = document.getElementById("panel-members");
const viewMain = document.getElementById("view-main");
const viewChannels = document.getElementById("view-channels");
const panelHints = document.getElementById("panel-hints");

// Button-hint glyphs per controller family. Positional: "accept" is always
// the south button — which a Nintendo pad labels B.
const GLYPHS = {
  xbox: { accept: "A", back: "B" },
  playstation: { accept: "✕", back: "○" },
  nintendo: { accept: "B", back: "A" },
};

let state = null;
let view = "main"; // "main" | "channels"
let focusIdx = 0;
let focusables = []; // [{ el, activate }] for the current view

api.onState((s) => {
  const wasOpen = state && state.panelOpen;
  state = s;
  if (s.panelOpen && !wasOpen) {
    view = "main";
    focusIdx = 0;
  }
  render();
});

api.onNav(handleNav);

// Keyboard fallback (panel has real focus while open): arrows/Enter/Escape.
document.addEventListener("keydown", (e) => {
  const map = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Enter: "accept",
    Escape: "back",
  };
  const action = map[e.key];
  if (action) {
    e.preventDefault();
    handleNav(action);
  }
});

function handleNav(action) {
  if (!state || !state.panelOpen) return;

  if (action === "back") {
    if (view === "channels") {
      view = "main";
      focusIdx = 0;
      render();
    } else {
      api.action("closePanel");
    }
    return;
  }

  if (action === "accept") {
    const item = focusables[focusIdx];
    if (item) item.activate();
    return;
  }

  const cols = view === "main" ? 2 : 1;
  let next = focusIdx;
  if (action === "up" && focusIdx - cols >= 0) next = focusIdx - cols;
  if (action === "down" && focusIdx + cols < focusables.length) next = focusIdx + cols;
  if (cols > 1) {
    if (action === "left" && focusIdx % cols > 0) next = focusIdx - 1;
    if (action === "right" && focusIdx % cols < cols - 1 && focusIdx + 1 < focusables.length) next = focusIdx + 1;
  }
  if (next !== focusIdx) {
    focusIdx = next;
    applyFocus();
  }
}

function applyFocus() {
  focusables.forEach((item, i) => item.el.classList.toggle("focused", i === focusIdx));
  const current = focusables[focusIdx];
  if (current) current.el.scrollIntoView({ block: "nearest" });
}

function render() {
  if (!state) return;
  document.documentElement.style.fontSize = `${16 * (state.hudScale || 1)}px`;
  document.body.className = state.hudCorner.includes("bottom") ? "corner-bottom" : "corner-top";
  if (state.panelOpen) document.body.classList.add("panel-open");
  renderHud();
  renderPanel();
}

// ---- passive HUD ----

function renderHud() {
  const show = state.connected && state.channel && !state.hudHidden && !state.panelOpen;
  hud.classList.toggle("hidden", !show);
  if (!show) return;

  hudChannel.textContent = state.channel.name;
  hudFlags.textContent = state.self.deaf ? "🙉" : state.self.mute ? "🔇" : "";

  hudMembers.replaceChildren(...state.members.map(memberRow));
}

function memberRow(m) {
  const li = document.createElement("li");
  if (m.speaking) li.classList.add("speaking");

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  const initial = (m.name[0] || "?").toUpperCase();
  if (m.avatar) {
    const img = document.createElement("img");
    img.src = `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.png?size=64`;
    img.addEventListener("error", () => {
      img.remove();
      avatar.textContent = initial; // offline / missing avatar -> initials bubble
    });
    avatar.appendChild(img);
  } else {
    avatar.textContent = initial;
  }

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = m.name;

  const flags = document.createElement("span");
  flags.className = "mem-flags";
  flags.textContent = m.deafened ? "🙉" : m.muted ? "🔇" : "";

  li.append(avatar, name, flags);
  return li;
}

// ---- interactive panel ----

function renderPanel() {
  panel.classList.toggle("hidden", !state.panelOpen);
  if (!state.panelOpen) return;

  panelStatus.textContent = !state.connected
    ? "Discord not detected"
    : state.channel
      ? `🔊 ${state.channel.name}`
      : "Not in a voice channel";

  panelMembers.replaceChildren(
    ...state.members.map((m) => {
      const chip = document.createElement("span");
      chip.className = m.speaking ? "chip speaking" : "chip";
      chip.textContent = m.name;
      return chip;
    })
  );

  viewMain.classList.toggle("hidden", view !== "main");
  viewChannels.classList.toggle("hidden", view !== "channels");
  if (view === "main") renderMainView();
  renderHints();
}

function mainButtons() {
  return [
    {
      icon: "🎙️",
      label: state.self.mute || state.self.deaf ? "Unmute" : "Mute",
      act: () => api.action("toggleMute"),
    },
    {
      icon: "🎧",
      label: state.self.deaf ? "Undeafen" : "Deafen",
      act: () => api.action("toggleDeafen"),
    },
    {
      icon: "📴",
      label: "Disconnect",
      danger: true,
      act: () => api.action("disconnect"),
    },
    {
      icon: "👁️",
      label: state.hudHidden ? "Show HUD" : "Hide HUD",
      act: () => api.action("toggleHud"),
    },
    {
      icon: "✖",
      label: "Quit CouchCord",
      danger: true,
      act: () => api.action("quit"),
    },
  ];
}

function renderMainView() {
  const buttons = mainButtons();
  focusIdx = Math.min(focusIdx, buttons.length - 1);
  focusables = buttons.map((b) => {
    const el = document.createElement("button");
    el.className = b.danger ? "big-btn danger" : "big-btn";
    const icon = document.createElement("span");
    icon.className = "btn-icon";
    icon.textContent = b.icon;
    const label = document.createElement("span");
    label.textContent = b.label;
    el.append(icon, label);
    el.addEventListener("click", b.act); // mouse still works if one is around
    return { el, activate: b.act };
  });
  viewMain.replaceChildren(...focusables.map((f) => f.el));
  applyFocus();
}

function renderHints() {
  const g = GLYPHS[state.controllerFamily] || GLYPHS.xbox;
  panelHints.replaceChildren(
    hint("D-pad", "Move"),
    hint(g.accept, "Select"),
    hint(g.back, view === "channels" ? "Back" : "Close"),
    hint("⌂", "Hold chord to close")
  );
}

function hint(glyph, text) {
  const wrap = document.createElement("span");
  wrap.className = "hint";
  const btn = document.createElement("span");
  btn.className = "hint-btn";
  btn.textContent = glyph;
  const label = document.createElement("span");
  label.textContent = text;
  wrap.append(btn, label);
  return wrap;
}
