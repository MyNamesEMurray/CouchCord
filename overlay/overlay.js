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
const viewList = document.getElementById("view-list");
const listTitle = document.getElementById("list-title");
const listRows = document.getElementById("list-rows");
const listHint = document.getElementById("list-hint");
const panelHints = document.getElementById("panel-hints");

// Button-hint glyphs per controller family. Positional: "accept" is always
// the south button — which a Nintendo pad labels B.
const GLYPHS = {
  xbox: { accept: "A", back: "B" },
  playstation: { accept: "✕", back: "○" },
  nintendo: { accept: "B", back: "A" },
};

let state = null;
let view = "main"; // "main" | "servers" | "channels"
let focusIdx = 0;
let focusables = []; // [{ el, activate }] for the current view
let guilds = undefined; // undefined = loading, null = fetch failed, [] = fetched
let channels = undefined; // same convention, for the selected guild
let selectedGuild = null; // { id, name } while in the channels view

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
      // Back to the server picker, focus restored to the server we came from.
      view = "servers";
      focusIdx = Array.isArray(guilds)
        ? Math.max(0, guilds.findIndex((g) => selectedGuild && g.id === selectedGuild.id))
        : 0;
      render();
    } else if (view === "servers") {
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
  viewList.classList.toggle("hidden", view === "main");
  if (view === "main") renderMainView();
  else renderListView();
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
      icon: "🔀",
      label: "Voice Channels",
      act: openServers,
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

function openServers() {
  view = "servers";
  focusIdx = 0;
  guilds = undefined;
  render();
  api.listGuilds().then((list) => {
    if (view !== "servers") return; // user backed out while loading
    guilds = list;
    if (Array.isArray(list)) {
      // Land on the server you're connected to (or were last connected to).
      const homeId = (state.channel && state.channel.guildId) || state.lastGuildId;
      focusIdx = Math.max(0, list.findIndex((g) => g.id === homeId));
    }
    render();
  });
}

function openChannels(guild) {
  view = "channels";
  selectedGuild = guild;
  focusIdx = 0;
  channels = undefined;
  render();
  api.listChannels(guild.id).then((list) => {
    if (view !== "channels" || !selectedGuild || selectedGuild.id !== guild.id) return;
    channels = list;
    if (Array.isArray(list)) focusIdx = Math.max(0, list.findIndex((c) => c.current));
    render();
  });
}

// Shared renderer for the two drill-down levels: pick a server, then one of
// its voice channels.
function renderListView() {
  const isServers = view === "servers";
  const data = isServers ? guilds : channels;
  listTitle.textContent = isServers ? "Choose a server" : selectedGuild ? selectedGuild.name : "";

  let hintText = null;
  if (data === undefined) hintText = isServers ? "Loading servers…" : "Loading channels…";
  else if (data === null) hintText = "Discord didn't answer — close and try again.";
  else if (data.length === 0) hintText = isServers ? "No servers found." : "No voice channels in this server.";

  listHint.classList.toggle("hidden", !hintText);
  if (hintText) listHint.textContent = hintText;

  const rows = Array.isArray(data) ? data : [];
  focusIdx = Math.min(focusIdx, Math.max(0, rows.length - 1));
  focusables = rows.map((item) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = isServers ? `🌐 ${item.name}` : `🔊 ${item.name}`;
    li.appendChild(label);
    const isCurrent = isServers
      ? state.channel && state.channel.guildId === item.id
      : item.current;
    if (isCurrent) {
      const tag = document.createElement("span");
      tag.className = "current-tag";
      tag.textContent = "CONNECTED";
      li.appendChild(tag);
    }
    const activate = isServers
      ? () => openChannels(item)
      : () => {
          api.action("join", item.id);
          view = "main";
          focusIdx = 0;
          render();
        };
    li.addEventListener("click", activate);
    return { el: li, activate };
  });
  listRows.replaceChildren(...focusables.map((f) => f.el));
  applyFocus();
}

function renderHints() {
  const g = GLYPHS[state.controllerFamily] || GLYPHS.xbox;
  panelHints.replaceChildren(
    hint("D-pad", "Move"),
    hint(g.accept, "Select"),
    hint(g.back, view === "main" ? "Close" : "Back"),
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
