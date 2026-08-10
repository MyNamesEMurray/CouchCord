"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Installed builds have no console, so every line also lands in
// couchcord.log next to config.json — the file to paste when reporting bugs.
function createLogger(dir) {
  const file = path.join(dir, "couchcord.log");
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
      fs.renameSync(file, `${file}.old`);
    }
  } catch {}
  return {
    file,
    log(line) {
      const stamped = `[${new Date().toISOString()}] ${line}`;
      console.log(stamped);
      try {
        fs.appendFileSync(file, `${stamped}\n`);
      } catch {}
    },
  };
}

module.exports = { createLogger };
