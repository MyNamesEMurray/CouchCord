"use strict";

const api = window.couchcord;

const hud = document.getElementById("hud");
const hudChannel = document.getElementById("hud-channel");
const hudFlags = document.getElementById("hud-flags");
const hudMembers = document.getElementById("hud-members");

let state = null;

api.onState((s) => {
  state = s;
  render();
});

function render() {
  if (!state) return;
  document.documentElement.style.fontSize = `${16 * (state.hudScale || 1)}px`;
  document.body.className = state.hudCorner.includes("bottom") ? "corner-bottom" : "corner-top";
  renderHud();
}

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
