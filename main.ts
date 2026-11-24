// The World in One Image — Tuesday 24 November 2026.
//
// A program that draws a one-page newspaper poster summing up the world's news
// of Tuesday 24 November 2026 and writes it to /output/entry.png.
// Node standard library only, no network, no assets on disk: the raster canvas,
// the stroke typeface and the PNG encoder all live in this file, so every run
// writes exactly the same bytes.
//
// Run locally with:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// PNG encoder (deterministic: fixed filter choice per row, zlib level 9)
// ---------------------------------------------------------------------------

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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgb) {
  // One filter byte per row; use the Sub filter everywhere (flat poster art
  // compresses well and the choice is fixed, so the bytes are stable).
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x];
      const prev = x >= 3 ? rgb[y * stride + x - 3] : 0;
      raw[row + 1 + x] = (v - prev) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Raster canvas, supersampled 2x and box-downsampled for anti-aliasing.
// All drawing happens in output pixels; the SS factor is applied internally.
// ---------------------------------------------------------------------------

const SS = 2;
const W = 1024;
const H = 1024;
const px = new Float32Array(W * SS * H * SS * 3);

function blend(x, y, r, g, b, a) {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= W * SS || y >= H * SS) return;
  const i = (y * W * SS + x) * 3;
  px[i] += (r - px[i]) * a;
  px[i + 1] += (g - px[i + 1]) * a;
  px[i + 2] += (b - px[i + 2]) * a;
}

function fillAll(col) {
  for (let i = 0; i < px.length; i += 3) {
    px[i] = col[0];
    px[i + 1] = col[1];
    px[i + 2] = col[2];
  }
}

function rect(x, y, w, h, col) {
  const x0 = Math.round(x * SS), y0 = Math.round(y * SS);
  const x1 = Math.round((x + w) * SS), y1 = Math.round((y + h) * SS);
  for (let j = y0; j < y1; j++)
    for (let i = x0; i < x1; i++) blend(i, j, col[0], col[1], col[2], 1);
}

// Filled polygon with anti-aliased edges (scanline, coverage from the SS grid).
function poly(points, col) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of points) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const y0 = Math.max(0, Math.floor(minY * SS)), y1 = Math.min(H * SS - 1, Math.ceil(maxY * SS));
  const n = points.length;
  for (let j = y0; j <= y1; j++) {
    const cy = (j + 0.5) / SS;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n];
      if ((a[1] <= cy && b[1] > cy) || (b[1] <= cy && a[1] > cy))
        xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.floor(xs[k] * SS), xb = Math.ceil(xs[k + 1] * SS);
      for (let i = xa; i <= xb; i++) blend(i, j, col[0], col[1], col[2], 1);
    }
  }
}

function circle(cx, cy, r, col) {
  const x0 = Math.floor((cx - r) * SS), x1 = Math.ceil((cx + r) * SS);
  const y0 = Math.floor((cy - r) * SS), y1 = Math.ceil((cy + r) * SS);
  for (let j = y0; j <= y1; j++)
    for (let i = x0; i <= x1; i++) {
      const dx = (i + 0.5) / SS - cx, dy = (j + 0.5) / SS - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.min(1, Math.max(0, (r - d) * SS + 0.5));
      blend(i, j, col[0], col[1], col[2], a);
    }
}

// One stroke segment with round caps: distance-to-segment coverage.
function seg(x1, y1, x2, y2, wdt, col) {
  const hw = wdt / 2;
  const minx = Math.floor((Math.min(x1, x2) - hw - 1) * SS), maxx = Math.ceil((Math.max(x1, x2) + hw + 1) * SS);
  const miny = Math.floor((Math.min(y1, y2) - hw - 1) * SS), maxy = Math.ceil((Math.max(y1, y2) + hw + 1) * SS);
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  for (let j = miny; j <= maxy; j++)
    for (let i = minx; i <= maxx; i++) {
      const cx = (i + 0.5) / SS, cy = (j + 0.5) / SS;
      let t = len2 === 0 ? 0 : ((cx - x1) * dx + (cy - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = x1 + t * dx - cx, ey = y1 + t * dy - cy;
      const d = Math.sqrt(ex * ex + ey * ey);
      const a = Math.min(1, Math.max(0, (hw - d) * SS + 0.5));
      if (a > 0) blend(i, j, col[0], col[1], col[2], a);
    }
}

function strokePath(points, wdt, col) {
  for (let i = 0; i + 1 < points.length; i++)
    seg(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], wdt, col);
}

function downsample() {
  const out = Buffer.alloc(W * H * 3);
  const sw = W * SS;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < SS; j++)
        for (let i = 0; i < SS; i++) {
          const k = ((y * SS + j) * sw + x * SS + i) * 3;
          r += px[k]; g += px[k + 1]; b += px[k + 2];
        }
      const o = (y * W + x) * 3, n = SS * SS;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  return out;
}

// ---------------------------------------------------------------------------
// A stroke typeface drawn by hand for this poster. Glyph space: cap height 10
// (y = 0 at the cap line, y = 10 at the baseline), x-height at y = 5,
// descenders to y = 13.5. Each glyph is a list of polylines, or { fill } for
// solid shapes (triangles), or { dot } for a round full stop.
// ---------------------------------------------------------------------------

function earc(cx, cy, rx, ry, a0, a1, steps = 28) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

const F = {};
function G(ch, strokes, adv) { F[ch] = { s: strokes, a: adv }; }

// Uppercase
G('A', [[[0, 10], [4, 0], [8, 10]], [[1.6, 6.7], [6.4, 6.7]]], 9.4);
G('B', [[[0, 10], [0, 0]], [[0, 0], [3.6, 0], ...earc(3.6, 2.5, 2.5, 2.5, -90, 90), [3.6, 5], [0, 5]], [[0, 5], [4.2, 5], ...earc(4.2, 7.5, 2.5, 2.5, -90, 90), [4.2, 10], [0, 10]]], 8.6);
G('C', [earc(4.3, 5, 4.1, 5, 55, 305)], 9.2);
G('D', [[[0, 10], [0, 0], [3, 0], ...earc(3, 5, 4.4, 5, -90, 90), [3, 10], [0, 10]]], 8.8);
G('E', [[[7, 0], [0, 0], [0, 10], [7, 10]], [[0, 5], [5.4, 5]]], 8.2);
G('F', [[[7, 0], [0, 0], [0, 10]], [[0, 5], [5.4, 5]]], 8.0);
G('G', [[...earc(4.3, 5, 4.1, 5, 55, 325)], [[8.6, 6.4], [5.1, 6.4], [5.1, 10]]], 9.4);
G('H', [[[0, 10], [0, 0]], [[8, 10], [8, 0]], [[0, 5], [8, 5]]], 9.4);
G('I', [[[0, 0], [3, 0]], [[1.5, 0], [1.5, 10]], [[0, 10], [3, 10]]], 4.4);
G('J', [[[7, 0], [7, 8], [5.6, 9.9], [2.8, 10.1], [1, 8.8], [0.7, 7.2]]], 8.2);
G('K', [[[0, 10], [0, 0]], [[7.4, 0], [1, 5.8]], [[1.9, 4.9], [8, 10]]], 9.2);
G('L', [[[0, 0], [0, 10], [7, 10]]], 8.2);
G('M', [[[0, 10], [0, 0], [4.5, 6], [9, 0], [9, 10]]], 10.4);
G('N', [[[0, 10], [0, 0], [8, 10], [8, 0]]], 9.4);
G('O', [earc(4.25, 5, 4.25, 5, 0, 360)], 9.6);
G('P', [[[0, 10], [0, 0], [4, 0], ...earc(4, 2.7, 3.6, 2.7, -90, 90), [4, 5.4], [0, 5.4]]], 8.8);
G('Q', [earc(4.25, 5, 4.25, 5, 0, 360), [[5.4, 7.8], [8.6, 11.4]]], 9.6);
G('R', [[[0, 10], [0, 0], [4, 0], ...earc(4, 2.7, 3.6, 2.7, -90, 90), [4, 5.4], [0, 5.4]], [[4.1, 5.4], [8, 10]]], 9.2);
G('S', [[[7.2, 1.9], [5.2, 0.3], [2.8, 0.2], [1.1, 1.2], [0.9, 2.9], [2.1, 4.3], [6, 5.9], [7.3, 7.3], [7.1, 9.1], [5.3, 10.2], [2.7, 10.2], [0.8, 9.1]]], 8.6);
G('T', [[[0, 0], [8, 0]], [[4, 0], [4, 10]]], 9.0);
G('U', [[[0, 0], [0, 7.4], ...earc(4, 7.4, 4, 2.6, 180, 0), [8, 7.4], [8, 0]]], 9.4);
G('V', [[[0, 0], [4, 10], [8, 0]]], 9.2);
G('W', [[[0, 0], [2, 10], [4.6, 3.6], [7.2, 10], [9.6, 0]]], 11.0);
G('X', [[[0, 0], [8, 10]], [[0, 10], [8, 0]]], 9.2);
G('Y', [[[0, 0], [4, 5], [8, 0]], [[4, 5], [4, 10]]], 9.2);
G('Z', [[[0, 0], [8, 0], [0, 10], [8, 10]]], 9.2);

// Lowercase
G('a', [earc(3, 7.5, 3, 2.5, 0, 360), [[6, 5], [6, 10]]], 7.6);
G('b', [[[0, 0], [0, 10]], earc(3.3, 7.5, 3.1, 2.5, 0, 360)], 7.8);
G('c', [earc(3.1, 7.5, 3.1, 2.5, 55, 305)], 7.2);
G('d', [earc(3, 7.5, 3, 2.5, 0, 360), [[6, 0], [6, 10]]], 7.8);
G('e', [[[0.3, 7.4], [6.1, 7.4]], earc(3.1, 7.5, 3.1, 2.5, 0, 330)], 7.4);
G('f', [[[5.2, 1], [4, 0.2], [2.9, 0.8], [2.7, 2.6], [2.7, 10]], [[0.8, 3.4], [4.8, 3.4]]], 5.8);
G('g', [earc(3, 7.5, 3, 2.5, 0, 360), [[6, 5], [6, 11.4], ...earc(3, 11.4, 3, 2.1, 0, 175)]], 7.8);
G('h', [[[0, 10], [0, 0]], [[0, 7], [0.9, 5.4], [3.1, 5], [5.1, 5.4], [6, 7], [6, 10]]], 7.6);
G('i', [[[3, 5], [3, 10]], { dot: [3, 1.9, 0.62] }], 4.6);
G('j', [[[3, 5], [3, 11.6], [2.1, 13.2], [0.7, 13.1], [0.4, 11.9]], { dot: [3, 1.9, 0.62] }], 5.0);
G('k', [[[0, 0], [0, 10]], [[5.8, 5], [1, 7.9]], [[1.7, 7.1], [6, 10]]], 7.4);
G('l', [[[1.5, 0], [1.5, 10]]], 3.6);
G('m', [[[0, 10], [0, 5]], [[0, 7], [0.7, 5.4], [2.2, 5.1], [3.7, 5.4], [4.4, 7], [4.4, 10]], [[4.4, 7], [5.1, 5.4], [6.6, 5.1], [8.1, 5.4], [8.8, 7], [8.8, 10]]], 10.2);
G('n', [[[0, 10], [0, 5]], [[0, 7], [0.8, 5.4], [3, 5], [5.1, 5.4], [6, 7], [6, 10]]], 7.6);
G('o', [earc(3.1, 7.5, 3.1, 2.5, 0, 360)], 7.4);
G('p', [earc(3, 7.5, 3, 2.5, 0, 360), [[0, 5], [0, 13.5]]], 7.8);
G('q', [earc(3, 7.5, 3, 2.5, 0, 360), [[6, 5], [6, 13.5], [7.4, 12.7]]], 8.2);
G('r', [[[0, 10], [0, 5]], [[0, 6.6], [1.2, 5.3], [3.4, 5], [5, 5.5]]], 6.2);
G('s', [[[5.8, 6.1], [4.2, 5.1], [1.9, 5.1], [0.8, 5.9], [1, 7], [2.1, 7.9], [4.9, 8.7], [5.9, 9.4], [5.3, 10.4], [3.3, 10.9], [1.2, 10.6], [0.4, 9.8]]], 7.0);
G('t', [[[2.8, 1.5], [2.8, 8.7], [3.6, 9.9], [5.3, 9.9]], [[0.6, 4], [5, 4]]], 6.0);
G('u', [[[0, 5], [0, 8.3], [0.9, 9.7], [3, 10.1], [5.1, 9.7], [6, 8.3], [6, 5]], [[6, 7.6], [6, 10]]], 7.6);
G('v', [[[0, 5], [3, 10], [6, 5]]], 7.2);
G('w', [[[0, 5], [1.8, 10], [3.6, 6.2], [5.4, 10], [7.2, 5]]], 8.6);
G('x', [[[0, 5], [6, 10]], [[0, 10], [6, 5]]], 7.2);
G('y', [[[0, 5], [3, 8.6], [6, 5]], [[6, 5], [5.1, 10.4], [3.9, 13], [1.9, 13.4], [0.7, 12.5]]], 7.4);
G('z', [[[0, 5], [6, 5], [0, 10], [6, 10]]], 7.2);

// Digits
G('0', [earc(3.5, 5, 3.5, 5, 0, 360)], 8.2);
G('1', [[[1.8, 2.8], [4.4, 0.4], [4.4, 10]], [[1.8, 10], [6.8, 10]]], 7.6);
G('2', [[...earc(3.5, 2.8, 3.3, 2.8, 180, 350), [0.4, 10], [7.4, 10]]], 8.4);
G('3', [[...earc(3.4, 2.6, 3.2, 2.6, -90, 90)], [...earc(3.6, 7.4, 3.4, 2.6, -90, 90)]], 8.2);
G('4', [[[5.5, 10], [5.5, 0], [0, 7], [7.6, 7]]], 8.6);
G('5', [[[7, 0], [1.2, 0], [1.2, 4.1], ...earc(3.8, 7.2, 3.4, 2.8, -95, 105), [2.2, 10.1]]], 8.4);
G('6', [[[6.6, 1.4], [3.4, 3.6], [1.1, 6.1], ...earc(3.6, 7.2, 3.4, 2.8, 180, 540)]], 8.4);
G('7', [[[0, 0], [7.6, 0], [3.2, 10]]], 8.6);
G('8', [earc(3.5, 2.6, 2.9, 2.6, 0, 360), earc(3.5, 7.3, 3.3, 2.7, 0, 360)], 8.2);
G('9', [[...earc(3.5, 2.8, 3.4, 2.8, 0, 360)], [[6.9, 3.2], [5.2, 7.2], [2.6, 9.6]]], 8.4);

// Punctuation and symbols
G(' ', [], 4.6);
G('.', [{ dot: [1.5, 10, 0.62] }], 3.4);
G(',', [{ dot: [1.7, 9.8, 0.6] }, [[2.4, 10], [1.4, 12.4]]], 3.6);
G(':', [{ dot: [1.5, 5.2, 0.6] }, { dot: [1.5, 10, 0.6] }], 3.4);
G(';', [{ dot: [1.5, 5.2, 0.6] }, { dot: [1.7, 9.8, 0.58] }, [[2.4, 10], [1.4, 12.4]]], 3.6);
G('!', [[[2, 0], [2, 6.8]], { dot: [2, 10, 0.62] }], 3.8);
G('?', [[[1, 3.6], [1.2, 1.3], [3.4, 0.2], [5.8, 1], [6.2, 2.8], [5, 4.8], [3.4, 6], [3.4, 7.8]], { dot: [3.4, 10, 0.62] }], 7.6);
G('-', [[[0.5, 7], [5, 7]]], 6.2);
G('–', [[[0.5, 7], [6.5, 7]]], 7.6);
G('—', [[[0, 7], [9, 7]]], 10.0);
G("'", [[[2.6, 0.4], [2.2, 3]]], 3.6);
G('’', [[[2.6, 0.4], [2.2, 3]]], 3.6);
G('"', [[[1.8, 0.4], [1.4, 3]], [[4.6, 0.4], [4.2, 3]]], 6.0);
G('(', [earc(4.6, 6.5, 3.1, 6.5, 115, 245)], 5.4);
G(')', [earc(0.6, 6.5, 3.1, 6.5, -65, 65)], 5.4);
G('/', [[[1, 10.6], [6.4, -0.4]]], 7.2);
G('%', [earc(1.9, 2.1, 1.8, 1.9, 0, 360), earc(6.4, 8.4, 1.8, 1.9, 0, 360), [[7.6, 0], [0.6, 10.4]]], 9.4);
G('$', [[[6.9, 2.4], [5, 0.6], [2.6, 0.5], [1.2, 1.6], [1.4, 3.4], [2.6, 4.6], [5.9, 6], [6.9, 7.4], [6.4, 9.3], [4.4, 10.3], [1.9, 10], [0.8, 9]], [[4, -0.6], [4, 10.8]]], 8.4);
G('£', [[[6.6, 1.6], [4.6, 0.3], [2.9, 1], [2.7, 3.2], [2.7, 6.4], [1.6, 10], [7.2, 10]], [[1.3, 6.2], [5.6, 6.2]]], 8.4);
G('€', [earc(4.6, 5, 4.2, 5, 50, 310), [[0.6, 3.9], [5.2, 3.9]], [[0.6, 6.3], [5.2, 6.3]]], 9.0);
G('+', [[[4, 2.4], [4, 9.6]], [[0.6, 6], [7.4, 6]]], 8.6);
G('=', [[[0.6, 4.2], [7.2, 4.2]], [[0.6, 7.6], [7.2, 7.6]]], 8.4);
G('&', [[[6.4, 9.6], [2.6, 5.2], [1.2, 3.4], [1.6, 1.2], [3.6, 0.6], [4.6, 2], [3.4, 4.6], [1.2, 6.8], [1.4, 9.2], [3.4, 10.2], [5.6, 9.4], [7.6, 6.6]]], 9.0);
G('#', [[[2.4, -0.2], [1.8, 10.2]], [[5.6, -0.2], [5, 10.2]], [[0.2, 3.8], [7.2, 3.8]], [[0, 6.9], [7, 6.9]]], 8.2);
G('•', [{ dot: [2, 6.8, 0.95] }], 4.4);
G('·', [{ dot: [1.6, 7, 0.55] }], 3.4);
G('…', [{ dot: [1.2, 10, 0.55] }, { dot: [4.2, 10, 0.55] }, { dot: [7.2, 10, 0.55] }], 9.0);
G('▲', [{ fill: [[4, 1.6], [7.6, 8.6], [0.4, 8.6]] }], 9.0);
G('▼', [{ fill: [[4, 8.6], [7.6, 1.6], [0.4, 1.6]] }], 9.0);
G('→', [[[0.4, 6], [7.6, 6]], [[5, 3.2], [7.8, 6], [5, 8.8]]], 9.2);
G('°', [earc(2.6, 2.4, 2.2, 2.2, 0, 360)], 5.6);

// ---------------------------------------------------------------------------
// Text drawing: size is the cap height in output pixels.
// ---------------------------------------------------------------------------

function glyphOf(ch) {
  return F[ch] || F[ch.toUpperCase()] || F['?'];
}

function textWidth(str, size, tracking = 0) {
  const u = size / 10;
  let w = 0;
  for (const ch of str) w += glyphOf(ch).a * u + tracking;
  return w - (str.length ? tracking : 0);
}

function drawText(str, x, yBase, size, col, opt = {}) {
  const u = size / 10;
  const wdt = size * (opt.bold ? 0.155 : 0.115);
  const tracking = opt.tracking || 0;
  let cx = x;
  for (const ch of str) {
    const g = glyphOf(ch);
    for (const item of g.s) {
      if (Array.isArray(item)) {
        const pts = item.map(([gx, gy]) => [cx + gx * u, yBase - 10 * u + gy * u]);
        strokePath(pts, wdt, col);
      } else if (item.dot) {
        circle(cx + item.dot[0] * u, yBase - 10 * u + item.dot[1] * u, Math.max(item.dot[2] * u, wdt * 0.62), col);
      } else if (item.fill) {
        poly(item.fill.map(([gx, gy]) => [cx + gx * u, yBase - 10 * u + gy * u]), col);
      }
    }
    cx += g.a * u + tracking;
  }
  return cx - x - (str.length ? tracking : 0);
}

// Greedy word wrap to a maximum width; returns the lines.
function wrap(str, size, maxW, opt = {}) {
  const words = str.split(' ');
  const lines = [];
  let cur = '';
  for (const wd of words) {
    const trial = cur ? cur + ' ' + wd : wd;
    if (textWidth(trial, size, opt.tracking || 0) <= maxW || !cur) cur = trial;
    else { lines.push(cur); cur = wd; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawWrapped(str, x, yBase, size, col, maxW, lineH, opt = {}) {
  const lines = wrap(str, size, maxW, opt);
  lines.forEach((ln, i) => drawText(ln, x, yBase + i * lineH, size, col, opt));
  return lines.length;
}

// ---------------------------------------------------------------------------
// The poster: a one-page newspaper front page for Tuesday 24 November 2026.
// Every story below was reported on that day (see the design note kept with
// the build; sources are credited in the footer).
// ---------------------------------------------------------------------------

const PAPER = [247, 243, 234];
const CARD = [254, 253, 249];
const RULE = [198, 188, 168];
const INK = [23, 23, 33];
const SOFT = [86, 86, 100];
const RED = [176, 32, 38];
const NAVY = [15, 27, 51];
const PANEL_TXT = [236, 239, 245];
const PANEL_SOFT = [176, 187, 207];
const GOLD = [214, 166, 38];

function hline(x, y, w, col, t = 2) { rect(x, y, w, t, col); }
function frameRect(x, y, w, h, col, t) {
  rect(x, y, w, t, col); rect(x, y + h - t, w, t, col);
  rect(x, y, t, h, col); rect(x + w - t, y, t, h, col);
}

function centered(str, yBase, size, col, opt = {}) {
  const w = textWidth(str, size, opt.tracking || 0);
  return drawText(str, (W - w) / 2, yBase, size, col, opt);
}

// Small drawn icons, ~30 px, in a single colour.
function iconBurst(cx, cy, r, col) {
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + 0.4;
    seg(cx + Math.cos(a) * r * 0.35, cy + Math.sin(a) * r * 0.35, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.6, col);
  }
  circle(cx, cy, r * 0.22, col);
}
function iconShip(cx, cy, r, col) {
  poly([[cx - r, cy + r * 0.25], [cx + r, cy + r * 0.25], [cx + r * 0.62, cy + r * 0.75], [cx - r * 0.62, cy + r * 0.75]], col);
  seg(cx, cy + r * 0.25, cx, cy - r * 0.8, 2.6, col);
  poly([[cx + 1, cy - r * 0.8], [cx + 1, cy + r * 0.1], [cx + r * 0.75, cy + r * 0.1]], col);
  strokePath(earc(cx - r * 0.4, cy + r * 1.05, r * 0.42, r * 0.22, 180, 360, 12), 2.2, col);
  strokePath(earc(cx + r * 0.45, cy + r * 1.05, r * 0.42, r * 0.22, 180, 360, 12), 2.2, col);
}
function iconSat(cx, cy, r, col) {
  strokePath(earc(cx, cy, r * 1.12, r * 0.52, 0, 360, 36), 2.1, col);
  circle(cx, cy, r * 0.34, col);
  const a = (-38 * Math.PI) / 180;
  circle(cx + Math.cos(a) * r * 1.12, cy + Math.sin(a) * r * 0.52, r * 0.17, col);
}
function iconChip(cx, cy, r, col) {
  frameRect(cx - r * 0.55, cy - r * 0.55, r * 1.1, r * 1.1, col, 2.6);
  rect(cx - r * 0.22, cy - r * 0.22, r * 0.44, r * 0.44, col);
  for (const s of [-0.66, 0, 0.66]) {
    seg(cx + s * r, cy - r * 0.95, cx + s * r, cy - r * 0.55, 2.2, col);
    seg(cx + s * r, cy + r * 0.55, cx + s * r, cy + r * 0.95, 2.2, col);
    seg(cx - r * 0.95, cy + s * r, cx - r * 0.55, cy + s * r, 2.2, col);
    seg(cx + r * 0.55, cy + s * r, cx + r * 0.95, cy + s * r, 2.2, col);
  }
}

function masthead() {
  // Kicker with flanking rules
  const kick = "TUESDAY'S WORLD NEWS · IN ONE IMAGE";
  const kw = textWidth(kick, 22, 3);
  drawText(kick, (W - kw) / 2, 52, 22, SOFT, { bold: true, tracking: 3 });
  hline(48, 43, (W - kw) / 2 - 72, RULE, 2.5);
  hline((W + kw) / 2 + 24, 43, (W - kw) / 2 - 72, RULE, 2.5);
  centered('24 NOVEMBER 2026', 130, 63, INK, { bold: true, tracking: 0.5 });
  hline(48, 146, W - 96, INK, 3.5);
  hline(48, 152, W - 96, INK, 1.2);
}

function leadPanel() {
  const x = 48, y = 164, w = W - 96, h = 250;
  rect(x, y, w, h, NAVY);
  // --- illustration: night skyline, the tallest tower, a strike burst
  const base = y + h - 24;
  circle(x + 262, y + 40, 11, [226, 230, 240]); // moon
  circle(x + 257, y + 36, 9.5, NAVY);
  const slate = [38, 56, 92], slate2 = [30, 46, 78];
  const buildings = [[4, 44, 64], [52, 36, 46], [92, 48, 84], [208, 40, 58], [252, 44, 76]];
  for (const [bx, bw, bh] of buildings) rect(x + bx, base - bh, bw, bh, slate);
  rect(x + 150, base - 126, 52, 126, slate2); // the tallest tower
  poly([[x + 150, base - 126], [x + 176, base - 158], [x + 202, base - 126]], slate2);
  seg(x + 176, base - 158, x + 176, base - 170, 3, slate2);
  const win = [250, 208, 96];
  for (let r = 0; r < 9; r++) for (let c = 0; c < 3; c++)
    if ((r * 3 + c) % 3 !== 1) rect(x + 158 + c * 14, base - 116 + r * 13, 6, 7, win);
  for (let r = 0; r < 5; r++) for (let c = 0; c < 2; c++)
    if ((r + c) % 2) rect(x + 100 + c * 15, base - 74 + r * 15, 6, 7, win);
  // missile trail: dashed arc from upper left to a burst beside the tower top
  const bx = x + 216, by = base - 138;
  let pxp = null;
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const qx = x + 14 + (bx - x - 14) * t;
    const qy = y + 24 + (by - y - 24) * t * t + Math.sin(t * Math.PI) * -12;
    if (pxp && i % 2 === 0) seg(pxp[0], pxp[1], qx, qy, 3, [240, 150, 90]);
    pxp = [qx, qy];
  }
  iconBurst(bx, by, 24, [245, 166, 60]);
  circle(bx, by, 6.5, [252, 220, 130]);
  rect(x, base, 300, 3, [52, 72, 110]);
  // --- lead text
  const tx = x + 324;
  rect(tx, y + 22, 132, 25, RED);
  drawText('TOP STORY', tx + 10, y + 41, 15.5, [255, 255, 255], { bold: true, tracking: 1.2 });
  drawText('RIYADH, SAUDI ARABIA', tx + 148, y + 41, 15.5, PANEL_SOFT, { bold: true, tracking: 1.2 });
  drawWrapped("Houthis strike Riyadh's tallest tower", tx, y + 84, 34, PANEL_TXT, w - 324 - 24, 42, { bold: true, tracking: -0.8 });
  drawWrapped("Yemen's Houthis hit the Saudi capital's tallest tower for a second time in five days, injuring 11 people. Houthi fighters are now 60 km from Aden.", tx, y + 168, 19, PANEL_SOFT, w - 324 - 24, 25, { tracking: -0.7 });
}

function card(cx, cy, cw, chh, cat, catCol, loc, head, body, icon) {
  rect(cx, cy, cw, chh, CARD);
  frameRect(cx, cy, cw, chh, RULE, 1.6);
  rect(cx, cy, cw, 5, catCol);
  if (icon) icon(cx + 27, cy + 27, 14.5, catCol);
  drawText(cat, cx + 52, cy + 33, 14.5, catCol, { bold: true, tracking: 1.4 });
  const lw = textWidth(loc, 14, 1);
  drawText(loc, cx + cw - 14 - lw, cy + 33, 14, SOFT, { tracking: 1 });
  const nHead = drawWrapped(head, cx + 14, cy + 64, 23, INK, cw - 28, 28, { bold: true, tracking: -0.7 });
  drawWrapped(body, cx + 14, cy + 64 + nHead * 28 + 2, 17.5, SOFT, cw - 28, 22.5, { tracking: -0.7 });
}

function poster() {
  fillAll(PAPER);
  frameRect(16, 16, W - 32, H - 32, INK, 2.5);
  masthead();
  leadPanel();

  const gx = 48, gw = (W - 96 - 14) / 2, gh = 170, gy = 428;
  card(gx, gy, gw, gh, 'WAR · GAZA', RED, 'GAZA STRIP',
    'Israeli strikes kill Hamas security chief',
    "Naeem Abu Nahel and six others, including two police officers, were killed, medics and police said.",
    iconBurst);
  card(gx + gw + 14, gy, gw, gh, 'WAR AT SEA', [30, 90, 150], 'BENGHAZI, LIBYA',
    'Ukraine sinks Russian corvette in a Libyan port',
    'Kyiv says seven naval drones sank the Merkury in Benghazi port; the UN urges an inquiry.',
    iconShip);
  card(gx, gy + gh + 12, gw, gh, 'SECURITY · SPACE', [96, 62, 160], 'BRUSSELS',
    'NATO vows to defend space after satellite reports',
    'Mark Rutte vowed to defend against any threat in space after reports of a Russian nuclear-armed satellite.',
    iconSat);
  card(gx + gw + 14, gy + gh + 12, gw, gh, 'ECONOMY · TECH', [176, 116, 16], 'UNITED STATES',
    'Nvidia brings back its chief — and shares leap',
    'The board reinstated Jensen Huang as CEO; shares jumped by a third. Washington blacklisted Megaspeed.',
    iconChip);

  // Also today
  const ay = gy + 2 * gh + 24 + 16;
  drawText('ALSO TODAY', gx, ay, 19, RED, { bold: true, tracking: 2.5 });
  hline(gx + 204, ay - 6, W - 96 - 204, RULE, 2);
  const also = [
    ['CLIMATE', 'COP31 climate summit ends without a deal; the EU seeks a rule change.'],
    ['DR CONGO', 'Fighting near an Ituri hospital traps Ebola responders for over a day.'],
    ['UKRAINE', 'Overnight strike on a Zaporizhzhia apartment block kills 2, wounds 40.'],
    ['SPORT', 'Senegal is restored as 2025 Africa Cup of Nations champion on appeal.'],
    ['ESTONIA', 'Russia warns of open war over a plan to close border crossings.'],
    ['SPACE', 'BepiColombo enters Mercury orbit after an eight-year journey.'],
  ];
  also.forEach(([tag, line], i) => {
    const ly = ay + 28 + i * 23.5;
    drawText(tag, gx + 4, ly, 16, INK, { bold: true, tracking: 0.8 });
    drawText(line, gx + 150, ly, 17, SOFT, { tracking: -0.6 });
  });

  // Footer: sources, then the markets line
  centered('Reported on Tuesday 24 November 2026 · Sources: AP · Reuters · BBC · UN News · The Guardian · Carbon Brief', ay + 28 + 6 * 23.5 + 4, 12.5, SOFT, {});
  hline(gx, 984, W - 96, INK, 2.2);
  centered('S&P 500 ▼0.95% · FTSE 100 ▼0.13% · NIKKEI ▲3.91% · BRENT $87.51 ▲0.96% · GOLD ▼2.28%', 1005, 14, INK, { bold: true, tracking: -0.3 });
}

poster();
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), encodePNG(W, H, downsample()));

