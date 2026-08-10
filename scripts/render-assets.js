"use strict";

// Renders the brand assets from their SVG/HTML masters:
//   assets/icon.svg   -> assets/icon.png (512) + assets/icon.ico (16..256)
//   assets/banner.html -> assets/banner.png (1200x300)
// Run with: npm run assets   (uses Electron as the rasterizer — no extra deps)

const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ASSETS = path.join(__dirname, "..", "assets");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// .ico container with PNG-compressed entries (supported since Windows Vista).
function icoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o); // 0 means 256
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

async function capture(url, width, height, transparent) {
  const win = new BrowserWindow({
    show: true,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent,
  });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 900)); // let fonts/SVG settle
  const img = await win.capturePage();
  win.destroy();
  return img;
}

app.on("window-all-closed", () => {}); // windows come and go between captures

app.whenReady().then(async () => {
  // Icon: rasterize once at 1024, downscale for every size. The SVG is
  // inlined because data: pages may not load file: subresources.
  const svg = fs
    .readFileSync(path.join(ASSETS, "icon.svg"), "utf8")
    .replace("<svg ", '<svg style="display:block;width:100vw;height:100vh" ');
  const iconPage =
    "data:text/html," + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`);
  const master = await capture(iconPage, 1024, 1024, true);
  fs.writeFileSync(path.join(ASSETS, "icon.png"), master.resize({ width: 512, height: 512 }).toPNG());
  const entries = ICO_SIZES.map((size) => ({
    size,
    buf: master.resize({ width: size, height: size }).toPNG(),
  }));
  fs.writeFileSync(path.join(ASSETS, "icon.ico"), icoFromPngs(entries));
  console.log(`wrote icon.png + icon.ico (${ICO_SIZES.join(", ")})`);

  const banner = await capture(`file://${path.join(ASSETS, "banner.html")}`, 1200, 300, false);
  fs.writeFileSync(path.join(ASSETS, "banner.png"), banner.toPNG());
  console.log("wrote banner.png");

  app.quit();
});
