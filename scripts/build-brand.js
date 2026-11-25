// Builds the app's icons and UI images from the CYL artwork in src/imgs (no dependencies).
//
//   node scripts/build-brand.js
//
// The two references are 1254 px squares: a rounded purple tile on an opaque white background.
//   logo_app.png      full logo (CYL + battery and EQ glyphs): app icon at 48 px and up, UI art
//   icon_bandeja.png  simpler tile (no glyphs): tray icon and the 16/24/32 px icon sizes, where the
//                     glyphs of the full logo would turn to noise
// The white outside the tile is removed by a flood fill from the corners, with the anti-aliased
// rim un-blended back to the tile colour so the edge stays smooth on dark and light backgrounds.
// Downscaling averages every source pixel that falls in a target pixel (premultiplied alpha).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'imgs');

// ---------- PNG decode (8-bit RGB/RGBA, non-interlaced) ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8; let w; let h; let depth; let type; let interlace; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const kind = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    if (kind === 'IDAT') idat.push(data);
    if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp; const out = Buffer.alloc(w * h * 4); const prev = Buffer.alloc(stride); const cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4; const s = x * bpp;
      out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    cur.copy(prev);
  }
  return { w, h, px: out };
}

// ---------- PNG encode (RGBA) ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(kind, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(kind, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng({ w, h, px }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- white background removal ----------
// A pixel belongs to the background when it is reachable from a corner through light pixels. Its
// alpha is how far it is from white toward the tile colour (measured on green, which is near 0 on
// the purple tile and 255 on white), and its colour is un-blended from white.
function cutBackground(img) {
  const { w, h, px } = img;
  const TILE_G = 40; const LIGHT = 150;
  const seen = new Uint8Array(w * h); const stack = [];
  const push = (x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = y * w + x; if (seen[i]) return; seen[i] = 1; if (px[i * 4 + 1] >= LIGHT) stack.push(i); else seen[i] = 2; };
  push(0, 0); push(w - 1, 0); push(0, h - 1); push(w - 1, h - 1);
  while (stack.length) { const i = stack.pop(); const x = i % w; const y = (i - x) / w; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
  let cleared = 0;
  for (let i = 0; i < w * h; i++) {
    if (seen[i] !== 1 && seen[i] !== 2) continue; // tile interior, untouched
    const o = i * 4; const g = px[o + 1];
    const a = Math.max(0, Math.min(1, (255 - g) / (255 - TILE_G)));
    if (a <= 0.02) { px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0; cleared++; continue; }
    for (let k = 0; k < 3; k++) px[o + k] = Math.max(0, Math.min(255, Math.round((px[o + k] - (1 - a) * 255) / a)));
    px[o + 3] = Math.round(a * 255);
  }
  return cleared;
}

// ---------- area-average downscale (premultiplied) ----------
function resize(img, size) {
  const { w, h, px } = img; const out = Buffer.alloc(size * size * 4);
  const sx = w / size; const sy = h / size;
  for (let ty = 0; ty < size; ty++) {
    const y0 = ty * sy; const y1 = y0 + sy;
    for (let tx = 0; tx < size; tx++) {
      const x0 = tx * sx; const x1 = x0 + sx;
      let r = 0; let g = 0; let b = 0; let a = 0; let wsum = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0); const wgt = wx * wy; const o = (y * w + x) * 4; const al = px[o + 3] / 255;
          r += px[o] * al * wgt; g += px[o + 1] * al * wgt; b += px[o + 2] * al * wgt; a += al * wgt; wsum += wgt;
        }
      }
      const o = (ty * size + tx) * 4;
      out[o + 3] = Math.round((a / wsum) * 255);
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
    }
  }
  return { w: size, h: size, px: out };
}

// Crops the transparent margin so the tile fills the square (keeps it square and centred).
function trim(img) {
  const { w, h, px } = img; let minX = w; let minY = h; let maxX = 0; let maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 8) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const side = Math.max(maxX - minX, maxY - minY) + 1; const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
  const ox = Math.round(cx - side / 2); const oy = Math.round(cy - side / 2); const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const sx = x + ox; const sy = y + oy; if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    px.copy(out, (y * side + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
  }
  return { w: side, h: side, px: out };
}

function ico(entries) {
  const head = Buffer.alloc(6 + entries.length * 16); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12); offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

function load(name) {
  const img = decodePng(fs.readFileSync(path.join(SRC, name)));
  const cleared = cutBackground(img);
  const t = trim(img);
  console.log(`${name}: ${img.w}x${img.h}, ${cleared} background pixels removed, tile ${t.w}px`);
  return t;
}

function main() {
  const logo = load('logo_app.png');
  const tile = load('icon_bandeja.png');
  const write = (rel, buf) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); console.log(`  ${rel} (${buf.length} bytes)`); };
  const png = (img, size) => encodePng(resize(img, size));

  // Windows icon: simple tile where it is tiny, the full logo where its glyphs are readable.
  write('assets/icon.ico', ico([16, 24, 32].map((s) => ({ size: s, png: png(tile, s) })).concat([48, 64, 128, 256].map((s) => ({ size: s, png: png(logo, s) })))));
  write('assets/icon.png', png(logo, 256));
  // Tray (16 px at 100 %, 32 px for 200 % displays) and notifications.
  write('assets/tray/cyl.png', png(tile, 16));
  write('assets/tray/cyl@2x.png', png(tile, 32));
  // Interface art: sidebar mark (32 px shown) and the About / empty-state logo (96 px shown).
  write('src/renderer/brand/cyl-mark.png', png(tile, 64));
  write('src/renderer/brand/cyl-logo.png', png(logo, 192));
}

if (require.main === module) main();
module.exports = { decodePng, encodePng, cutBackground, resize, trim, ico };
