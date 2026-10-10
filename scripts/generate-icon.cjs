// Renders media/icon.png (the Marketplace and Extensions view icon) from the same branch graph as media/git-pro.svg.
// No dependencies: shapes are signed-distance functions, supersampled for anti-aliasing, encoded with node:zlib.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256, SAMPLES = 4;
// Brand palette from longtd.me: accent #f2542d, accent-soft #ffc3ae, on-accent #1a0702, surface #121214.
// Each variant is a diagonal tile gradient plus the colour of the branch mark; `node generate-icon.cjs <variant> [file]` previews one.
const variants = {
  orange: { top: [0xff, 0x6b, 0x3d], bottom: [0xe2, 0x42, 0x1c], mark: [0xff, 0xff, 0xff] },
  'orange-dark-mark': { top: [0xff, 0x6b, 0x3d], bottom: [0xe2, 0x42, 0x1c], mark: [0x1a, 0x07, 0x02] },
  dark: { top: [0x1c, 0x1c, 0x21], bottom: [0x0a, 0x0a, 0x0a], mark: [0xf2, 0x54, 0x2d] }
};
// Dark tile with the orange mark: an orange tile with a white branch would read as Git's own logo (#f05032).
const chosen = process.argv[2] ?? 'dark', palette = variants[chosen];
if (!palette) throw new Error(`Unknown icon variant: ${chosen}`);
const corner = 56, inset = 8, { top, bottom, mark: markColor } = palette;
// The 24-unit logo (circles at 7,5 / 7,19 / 17,7; trunk 7,7-7,17; branch 17,9 → 17,11 → arc to 12,16 → 7,16), centred.
const scale = 9.2, offset = SIZE / 2 - 12 * scale, stroke = 15, radius = 2.15 * scale;
const map = (x, y) => [offset + x * scale, offset + y * scale];

const length = (x, y) => Math.hypot(x, y);
function segment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return length(px - ax - t * dx, py - ay - t * dy);
}
function quarterArc(px, py, [cx, cy], r) {
  // Lower-right quarter (x ≥ cx, y ≥ cy), from (cx + r, cy) to (cx, cy + r).
  if (px >= cx && py >= cy) return Math.abs(length(px - cx, py - cy) - r);
  return Math.min(length(px - cx - r, py - cy), length(px - cx, py - cy - r));
}
function roundedSquare(px, py) {
  const half = SIZE / 2 - inset, qx = Math.abs(px - SIZE / 2) - half + corner, qy = Math.abs(py - SIZE / 2) - half + corner;
  return length(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
}
const nodes = [map(7, 5), map(7, 19), map(17, 7)];
const lines = [[map(7, 7), map(7, 17)], [map(17, 9), map(17, 11)], [map(12, 16), map(7, 16)]];
const arc = { centre: map(12, 11), r: 5 * scale };
function graph(px, py) {
  let d = Infinity;
  for (const [x, y] of nodes) d = Math.min(d, Math.abs(length(px - x, py - y) - radius));
  for (const [a, b] of lines) d = Math.min(d, segment(px, py, a, b));
  return Math.min(d, quarterArc(px, py, arc.centre, arc.r)) - stroke / 2;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  let shape = 0, mark = 0;
  for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) {
    const px = x + (sx + 0.5) / SAMPLES, py = y + (sy + 0.5) / SAMPLES;
    if (roundedSquare(px, py) <= 0) { shape++; if (graph(px, py) <= 0) mark++; }
  }
  const coverage = shape / SAMPLES ** 2, share = shape ? mark / shape : 0, t = (x + y) / (2 * SIZE);
  const offsetIndex = (y * SIZE + x) * 4;
  for (let channel = 0; channel < 3; channel++) {
    const base = top[channel] + (bottom[channel] - top[channel]) * t;
    pixels[offsetIndex + channel] = Math.round(base + (markColor[channel] - base) * share);
  }
  pixels[offsetIndex + 3] = Math.round(255 * coverage);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const length = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]);
};
const header = Buffer.alloc(13); header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4); header.set([8, 6, 0, 0, 0], 8);
const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const output = path.resolve(process.argv[3] ?? path.join(__dirname, '..', 'media', 'icon.png'));
fs.writeFileSync(output, png);
console.log(`${path.relative(process.cwd(), output)}: ${SIZE}x${SIZE}, ${png.length} bytes`);
