#!/usr/bin/env node
//
// Generates the application mark and every raster the build needs.
//
// Why a generator rather than committed binaries: the icon set is six files
// across two formats and eight resolutions. Hand-produced blobs drift, and a
// PNG in git history carries no record of how it was made or how to change it.
// This script IS the source of truth - re-run it and the whole set is rebuilt
// deterministically.
//
// Deliberately dependency-free. PNG is deflate + CRC32, both in Node's stdlib,
// and ICO (Vista+) simply embeds PNG payloads, so nothing here needs sharp,
// canvas or an image toolchain that would have to be installed and audited.
//
// Current mark is a PLACEHOLDER agreed with the user: a red square centred
// inside a white circle.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");

// --- geometry -------------------------------------------------------------
// Fractions of the canvas edge, so every size is the same picture.
const CIRCLE_RADIUS = 0.48; // leaves a hairline of padding at the edge
const SQUARE_HALF = 0.26; // side 0.52 -> comfortably inside the circle,
//                           whose largest inscribed square has half-side
//                           0.48/sqrt(2) = 0.339
// A white disc on a transparent surround is INVISIBLE on a white background -
// Explorer's file pane, a light taskbar, and any light-themed app chrome. This
// was not a guess: the first generated logo.png measured [0,0,0,0] in the
// corners and [255,255,255,255] on the disc, and read on screen as a bare red
// square with no circle at all. A hairline ring gives the silhouette an edge
// without changing the mark.
const RING_WIDTH = 0.012;
const RING = [176, 176, 176];
const WHITE = [255, 255, 255];
const RED = [211, 47, 47]; // Material red 700 - readable on light and dark
const SUPERSAMPLE = 4; // 16 samples/pixel; the circle edge needs it at 16px

// Renders the mark into a straight (non-premultiplied) RGBA buffer.
function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const c = size / 2;
  const r = size * CIRCLE_RADIUS;
  const rInner = r - size * RING_WIDTH;
  const half = size * SQUARE_HALF;
  const step = 1 / SUPERSAMPLE;
  const offset = step / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let circleHits = 0;
      let innerHits = 0;
      let squareHits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + offset + sx * step;
          const py = y + offset + sy * step;
          const dx = px - c;
          const dy = py - c;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r * r) circleHits++;
          if (d2 <= rInner * rInner) innerHits++;
          if (Math.abs(dx) <= half && Math.abs(dy) <= half) squareHits++;
        }
      }
      const total = SUPERSAMPLE * SUPERSAMPLE;
      const circleA = circleHits / total;
      if (circleA === 0) continue;

      // The square is drawn over the circle, so composite square-over-white
      // first and let the circle's own coverage drive the final alpha. Doing
      // it the other way round leaves a red fringe outside the circle wherever
      // the square's antialiased edge lands on a transparent pixel.
      const innerA = innerHits / total;
      const ringA = circleA - innerA;
      const squareA = Math.min(squareHits / total, innerA);
      const whiteA = innerA - squareA;
      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        buf[i + ch] = Math.round(
          (RED[ch] * squareA + WHITE[ch] * whiteA + RING[ch] * ringA) / circleA,
        );
      }
      buf[i + 3] = Math.round(circleA * 255);
    }
  }
  return buf;
}

// --- PNG encoding ---------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  // Filter type 0 (None) on every scanline. The art is flat colour, so the
  // adaptive filters buy almost nothing and cost clarity here.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- ICO ------------------------------------------------------------------
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const b = i * 16;
    // 256 is encoded as 0 - the field is a single byte.
    dir[b] = e.size >= 256 ? 0 : e.size;
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir[b + 2] = 0; // palette
    dir[b + 3] = 0; // reserved
    dir.writeUInt16LE(1, b + 4); // colour planes
    dir.writeUInt16LE(32, b + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// --- outputs --------------------------------------------------------------
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_OUTPUTS = [
  ["logo.png", 512],
  ["logo_dark.png", 512],
  ["markdown_viewer_icon.png", 512],
  ["file-icon.png", 512],
];

function main() {
  const pngCache = new Map();
  const pngAt = (size) => {
    if (!pngCache.has(size)) pngCache.set(size, encodePNG(renderRGBA(size), size));
    return pngCache.get(size);
  };

  for (const [name, size] of PNG_OUTPUTS) {
    const out = path.join(ROOT, name);
    fs.writeFileSync(out, pngAt(size));
    console.log(`  ${name}  ${size}x${size}  (${(pngAt(size).length / 1024).toFixed(1)} KB)`);
  }

  const ico = encodeICO(ICO_SIZES.map((size) => ({ size, png: pngAt(size) })));
  for (const name of ["logo.ico", "file-icon.ico"]) {
    fs.writeFileSync(path.join(ROOT, name), ico);
    console.log(`  ${name}  ${ICO_SIZES.join("/")}  (${(ico.length / 1024).toFixed(1)} KB)`);
  }

  // An SVG master so the mark can be edited as vector art when the real logo
  // replaces this placeholder.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <circle cx="256" cy="256" r="${(512 * (CIRCLE_RADIUS - RING_WIDTH / 2)).toFixed(1)}" fill="#ffffff" stroke="rgb(${RING.join(",")})" stroke-width="${(512 * RING_WIDTH).toFixed(1)}"/>
  <rect x="${(256 - 512 * SQUARE_HALF).toFixed(1)}" y="${(256 - 512 * SQUARE_HALF).toFixed(1)}" width="${(1024 * SQUARE_HALF).toFixed(1)}" height="${(1024 * SQUARE_HALF).toFixed(1)}" fill="rgb(${RED.join(",")})"/>
</svg>
`;
  fs.writeFileSync(path.join(ROOT, "assets", "logo.svg"), svg, "utf8");
  console.log("  assets/logo.svg");
}

main();
