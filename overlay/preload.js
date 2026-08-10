"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("couchcord", {
  onState: (cb) => ipcRenderer.on("state", (_e, state) => cb(state)),
  onNav: (cb) => ipcRenderer.on("nav", (_e, action) => cb(action)),
  action: (type, payload) => ipcRenderer.send("action", { type, payload }),
  listChannels: () => ipcRenderer.invoke("listChannels"),
});
