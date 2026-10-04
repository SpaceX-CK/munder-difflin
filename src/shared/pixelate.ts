/**
 * Image -> 18x32 pixel-art character, deterministically (no AI).
 *
 * Pure: takes decoded RGBA pixels and returns RGBA buffers, so it is unit-testable
 * and shared by the studio (renderer) and the AI-redraw path (which sends the result
 * to Claude as a colour grid to refine).
 *
 * Pipeline: drop the background -> crop to the subject -> fit into 18x32 (aspect kept,
 * bottom-aligned, centred) -> shrink by voting per cell -> quantize to a small palette
 * -> optionally mirror the left half (so a character is exactly left/right symmetric)
 * -> add a 1px outline if the art has none -> derive a back view and the portrait.
 */
import { SCENE_W, SCENE_H, PORTRAIT_W, PORTRAIT_H, type Validated } from './customCharacter';

export interface RgbaImage { data: ArrayLike<number>; width: number; height: number }

export interface PixelateOptions {
  /** Mirror the left half onto the right (default true). */
  symmetric?: boolean;
  /** Background colour distance (0-441, euclidean RGB) treated as background (default 40). */
  bgTolerance?: number;
  /** Max palette size before the outline colour is added (default 15, max 24). */
  maxColors?: number;
  /** Add a 1px dark outline when the art has none (default true). */
  outline?: boolean;
  /** 'contain' keeps the aspect ratio (default); 'fill' stretches to the whole 18x32 frame. */
  fit?: 'contain' | 'fill';
}

export interface PixelateResult {
  front: Uint8ClampedArray;
  back: Uint8ClampedArray;
  portrait: Uint8ClampedArray;
}

export const MAX_IMAGE_PIXELS = 4096 * 4096;

type RGB = [number, number, number];
const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;
const sat = (r: number, g: number, b: number): number => {
  const mx = Math.max(r, g, b);
  return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx;
};
const dist = (a: RGB, b: RGB): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const keyOf = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
const isSkin = (r: number, g: number, b: number): boolean =>
  r > 170 && g > 110 && b > 70 && r > g && g > b && r - b > 25 && r - b < 130;
const isEye = (r: number, g: number, b: number): boolean => luma(r, g, b) > 200 && sat(r, g, b) < 0.18;

// ─── 1. background ───────────────────────────────────────────────────────────
/** 1 = subject, 0 = background. Alpha counts; otherwise flood in from the border by colour. */
function foregroundMask(img: RgbaImage, tol: number): Uint8Array {
  const { data, width: w, height: h } = img;
  const fg = new Uint8Array(w * h).fill(1);
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] < 128) fg[i] = 0;

  const border: number[] = [];
  for (let x = 0; x < w; x++) { border.push(x, (h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { border.push(y * w, y * w + w - 1); }
  const opaqueBorder = border.filter((p) => data[p * 4 + 3] >= 128);
  if (opaqueBorder.length * 2 < border.length) return fg; // transparent border: alpha is enough

  const counts = new Map<number, number>();
  for (const p of opaqueBorder) {
    const k = keyOf(data[p * 4] >> 3, data[p * 4 + 1] >> 3, data[p * 4 + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = -1, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  if (bestN * 2 < opaqueBorder.length) return fg; // no single dominant border colour: leave it
  const bg: RGB = [((best >> 16) & 31) * 8 + 4, ((best >> 8) & 31) * 8 + 4, (best & 31) * 8 + 4];

  const isBg = (p: number): boolean =>
    data[p * 4 + 3] >= 128 && dist([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]], bg) <= tol;
  const stack: number[] = [];
  const seen = new Uint8Array(w * h);
  for (const p of opaqueBorder) if (isBg(p)) { seen[p] = 1; stack.push(p); }
  while (stack.length) {
    const p = stack.pop()!;
    fg[p] = 0;
    const x = p % w, y = (p / w) | 0;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const q of nb) if (q >= 0 && !seen[q] && isBg(q)) { seen[q] = 1; stack.push(q); }
  }
  return fg;
}

// ─── 2. palette (median cut, exact when already small) ───────────────────────
interface Swatch { rgb: RGB; n: number }

function medianCut(colors: Swatch[], max: number): { palette: RGB[]; map: Map<number, number> } {
  const map = new Map<number, number>();
  if (colors.length <= max) {
    const palette = colors.map((c, i) => { map.set(keyOf(...c.rgb), i); return c.rgb; });
    return { palette, map };
  }
  let boxes: Swatch[][] = [colors];
  const range = (b: Swatch[], ch: number): number => {
    let lo = 255, hi = 0;
    for (const c of b) { lo = Math.min(lo, c.rgb[ch]); hi = Math.max(hi, c.rgb[ch]); }
    return hi - lo;
  };
  while (boxes.length < max) {
    let pick = -1, pickScore = 0, pickCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        const r = range(b, ch);
        if (r > pickScore) { pickScore = r; pick = i; pickCh = ch; }
      }
    });
    if (pick < 0) break;
    const b = boxes[pick].slice().sort((a, c) => a.rgb[pickCh] - c.rgb[pickCh]);
    const total = b.reduce((s, c) => s + c.n, 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < b.length - 1; i++) { acc += b[i].n; cut = i + 1; if (acc * 2 >= total) break; }
    boxes = [...boxes.slice(0, pick), b.slice(0, cut), b.slice(cut), ...boxes.slice(pick + 1)];
  }
  const palette: RGB[] = boxes.map((b, i) => {
    const total = b.reduce((s, c) => s + c.n, 0) || 1;
    for (const c of b) map.set(keyOf(...c.rgb), i);
    return [0, 1, 2].map((ch) => Math.round(b.reduce((s, c) => s + c.rgb[ch] * c.n, 0) / total)) as RGB;
  });
  return { palette, map };
}

// ─── 3. the pipeline ─────────────────────────────────────────────────────────
export function pixelateImage(img: RgbaImage, options: PixelateOptions = {}): Validated<PixelateResult> {
  const { width: w, height: h, data } = img;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return { ok: false, error: 'image has no size' };
  if (w * h > MAX_IMAGE_PIXELS) return { ok: false, error: 'image is too large' };
  if (data.length < w * h * 4) return { ok: false, error: 'image data is incomplete' };
  const symmetric = options.symmetric ?? true;
  const tol = options.bgTolerance ?? 40;
  const maxColors = Math.max(2, Math.min(24, Math.round(options.maxColors ?? 15)));

  const fg = foregroundMask(img, tol);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!fg[y * w + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { ok: false, error: 'no subject found (the image looks empty or all background)' };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

  // Palette over the subject only. Pre-bucket photos so the cut works on a few thousand colours.
  const exact = new Map<number, number>();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = y * w + x;
    if (!fg[p]) continue;
    const k = keyOf(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    exact.set(k, (exact.get(k) ?? 0) + 1);
  }
  let swatches: Swatch[];
  if (exact.size > 4096) {
    const bucket = new Map<number, { s: [number, number, number]; n: number }>();
    for (const [k, n] of exact) {
      const r = (k >> 16) & 255, g = (k >> 8) & 255, b = k & 255;
      const bk = keyOf(r >> 4, g >> 4, b >> 4);
      const e = bucket.get(bk) ?? { s: [0, 0, 0], n: 0 };
      e.s[0] += r * n; e.s[1] += g * n; e.s[2] += b * n; e.n += n;
      bucket.set(bk, e);
    }
    swatches = [...bucket.values()].map((e) => ({ rgb: e.s.map((v) => Math.round(v / e.n)) as RGB, n: e.n }));
  } else {
    swatches = [...exact].map(([k, n]) => ({ rgb: [(k >> 16) & 255, (k >> 8) & 255, k & 255] as RGB, n }));
  }
  const { palette, map } = medianCut(swatches, maxColors);
  const nearest = (r: number, g: number, b: number): number => {
    const hit = map.get(keyOf(r, g, b));
    if (hit !== undefined) return hit;
    let bi = 0, bd = Infinity;
    palette.forEach((c, i) => { const d = dist([r, g, b], c); if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  // Global share per palette colour: rare colours (eyes, belt) beat big flat areas in a cell vote.
  const share = new Array(palette.length).fill(0);
  let shareTotal = 0;
  for (const s of swatches) { share[nearest(...s.rgb)] += s.n; shareTotal += s.n; }
  const rarity = share.map((n) => 1 - n / shareTotal);

  // Fit into 18x32: aspect kept, centred, bottom-aligned.
  const s = Math.min(SCENE_W / bw, SCENE_H / bh);
  const fill = options.fit === 'fill';
  const tw = fill ? SCENE_W : Math.max(1, Math.min(SCENE_W, Math.round(bw * s)));
  const th = fill ? SCENE_H : Math.max(1, Math.min(SCENE_H, Math.round(bh * s)));
  const ox = Math.floor((SCENE_W - tw) / 2), oy = SCENE_H - th;
  const grid = new Int16Array(SCENE_W * SCENE_H).fill(-1);
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const sx0 = x0 + Math.floor((tx * bw) / tw), sx1 = Math.max(sx0 + 1, x0 + Math.ceil(((tx + 1) * bw) / tw));
    const sy0 = y0 + Math.floor((ty * bh) / th), sy1 = Math.max(sy0 + 1, y0 + Math.ceil(((ty + 1) * bh) / th));
    const votes = new Map<number, number>();
    let cells = 0, on = 0;
    for (let y = sy0; y < Math.min(sy1, y1 + 1); y++) for (let x = sx0; x < Math.min(sx1, x1 + 1); x++) {
      cells++;
      const p = y * w + x;
      if (!fg[p]) continue;
      on++;
      const pi = nearest(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
      votes.set(pi, (votes.get(pi) ?? 0) + 1 + 1.5 * rarity[pi]);
    }
    if (cells === 0 || on / cells < 0.45) continue;
    let bi = -1, bv = -1;
    for (const [pi, v] of votes) if (v > bv) { bv = v; bi = pi; }
    grid[(oy + ty) * SCENE_W + ox + tx] = bi;
  }

  // Exact left/right symmetry.
  if (symmetric) {
    for (let y = 0; y < SCENE_H; y++) for (let x = 0; x < SCENE_W / 2; x++) {
      grid[y * SCENE_W + (SCENE_W - 1 - x)] = grid[y * SCENE_W + x];
    }
  }

  const colors: RGB[] = palette.slice();
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= SCENE_W || y >= SCENE_H ? -1 : grid[y * SCENE_W + x]);

  // Outline: only if the art does not already have a dark edge.
  if (options.outline ?? true) {
    let edge = 0, dark = 0;
    for (let y = 0; y < SCENE_H; y++) for (let x = 0; x < SCENE_W; x++) {
      const v = at(x, y);
      if (v < 0) continue;
      if (at(x - 1, y) < 0 || at(x + 1, y) < 0 || at(x, y - 1) < 0 || at(x, y + 1) < 0) {
        edge++;
        if (luma(...colors[v]) < 70) dark++;
      }
    }
    if (edge > 0 && dark / edge < 0.6) {
      let oi = colors.findIndex((c) => luma(...c) < 40);
      if (oi < 0) { colors.push([20, 20, 28]); oi = colors.length - 1; }
      const add: number[] = [];
      for (let y = 0; y < SCENE_H; y++) for (let x = 0; x < SCENE_W; x++) {
        if (at(x, y) >= 0) continue;
        if (at(x - 1, y) >= 0 || at(x + 1, y) >= 0 || at(x, y - 1) >= 0 || at(x, y + 1) >= 0) add.push(y * SCENE_W + x);
      }
      for (const p of add) grid[p] = oi;
    }
  }

  const front = gridToRgba(grid, colors);
  const back = makeBack(front);
  return { ok: true, value: { front, back, portrait: front.slice(0, PORTRAIT_W * PORTRAIT_H * 4) } };
}

function gridToRgba(grid: Int16Array, colors: RGB[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SCENE_W * SCENE_H * 4);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] < 0) continue;
    const c = colors[grid[i]];
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
  }
  return out;
}

// ─── back view (a guess: face and chest emblems hidden) ──────────────────────
export function makeBack(front: Uint8ClampedArray): Uint8ClampedArray {
  const back = new Uint8ClampedArray(front);
  let top = -1, bottom = -1;
  for (let y = 0; y < SCENE_H && top < 0; y++) for (let x = 0; x < SCENE_W; x++) if (front[(y * SCENE_W + x) * 4 + 3]) { top = y; break; }
  for (let y = SCENE_H - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < SCENE_W; x++) if (front[(y * SCENE_W + x) * 4 + 3]) { bottom = y; break; }
  if (top < 0) return back;
  const height = bottom - top + 1;
  const headEnd = top + Math.round(height * 0.42);
  const px = (x: number, y: number): RGB => [front[(y * SCENE_W + x) * 4], front[(y * SCENE_W + x) * 4 + 1], front[(y * SCENE_W + x) * 4 + 2]];
  const on = (x: number, y: number): boolean => front[(y * SCENE_W + x) * 4 + 3] > 0;
  const common = (pred: (c: RGB) => boolean, y0: number, y1: number): RGB | null => {
    const n = new Map<number, number>();
    for (let y = y0; y < y1; y++) for (let x = 0; x < SCENE_W; x++) {
      if (!on(x, y)) continue;
      const c = px(x, y);
      if (pred(c)) n.set(keyOf(...c), (n.get(keyOf(...c)) ?? 0) + 1);
    }
    let bk = -1, bn = 0;
    for (const [k, v] of n) if (v > bn) { bn = v; bk = k; }
    return bk < 0 ? null : [(bk >> 16) & 255, (bk >> 8) & 255, bk & 255];
  };
  const headFill = common((c) => !isSkin(...c) && !isEye(...c) && luma(...c) > 25, top, headEnd)
    ?? common((c) => !isSkin(...c) && !isEye(...c), top, headEnd);
  // Torso: the dominant non-skin colour is the garment; small saturated patches (a belt,
  // a logo) are the "front-only" accents that get painted over on the back.
  const torsoEnd = Math.min(bottom + 1, headEnd + 10);
  const torsoCount = new Map<number, number>();
  let torsoTotal = 0;
  for (let y = headEnd; y < torsoEnd; y++) for (let x = 0; x < SCENE_W; x++) {
    if (!on(x, y)) continue;
    const c = px(x, y);
    if (isSkin(...c) || luma(...c) <= 25) continue;
    torsoCount.set(keyOf(...c), (torsoCount.get(keyOf(...c)) ?? 0) + 1);
    torsoTotal++;
  }
  let torsoKey = -1, torsoN = 0;
  for (const [k, v] of torsoCount) if (v > torsoN) { torsoN = v; torsoKey = k; }
  const torsoFill: RGB | null = torsoKey < 0 ? null : [(torsoKey >> 16) & 255, (torsoKey >> 8) & 255, torsoKey & 255];
  const isAccent = (c: RGB): boolean =>
    torsoKey >= 0 && keyOf(...c) !== torsoKey && sat(...c) > 0.55 && !isSkin(...c) &&
    (torsoCount.get(keyOf(...c)) ?? 0) / torsoTotal < 0.15;
  for (let y = top; y <= bottom; y++) for (let x = 0; x < SCENE_W; x++) {
    if (!on(x, y)) continue;
    const c = px(x, y);
    let fill: RGB | null = null;
    if (y < headEnd) { if (isSkin(...c) || isEye(...c)) fill = headFill; }
    else if (y < torsoEnd && isAccent(c)) fill = torsoFill; // belt / logo accents
    if (fill) { const o = (y * SCENE_W + x) * 4; back[o] = fill[0]; back[o + 1] = fill[1]; back[o + 2] = fill[2]; }
  }
  return back;
}

// ─── colour grid (the text form sent to Claude as a layout to refine) ────────
export function toColorGrid(front: Uint8ClampedArray): { rows: string[]; legend: { letter: string; hex: string }[] } {
  const counts = new Map<number, number>();
  for (let i = 0; i < SCENE_W * SCENE_H; i++) {
    if (!front[i * 4 + 3]) continue;
    const k = keyOf(front[i * 4], front[i * 4 + 1], front[i * 4 + 2]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const order = [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 25);
  const letter = new Map(order.map((k, i) => [k, String.fromCharCode(97 + i)]));
  const rows: string[] = [];
  for (let y = 0; y < SCENE_H; y++) {
    let r = '';
    for (let x = 0; x < SCENE_W; x++) {
      const i = y * SCENE_W + x;
      r += front[i * 4 + 3] ? (letter.get(keyOf(front[i * 4], front[i * 4 + 1], front[i * 4 + 2])) ?? '?') : '.';
    }
    rows.push(r);
  }
  return { rows, legend: order.map((k) => ({ letter: letter.get(k)!, hex: '#' + k.toString(16).padStart(6, '0') })) };
}
