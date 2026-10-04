'use strict';

// Image -> pixel-art: the deterministic engine (shared/pixelate.ts). Uses synthetic
// images only, so the suite has no dependency on files outside the repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { pixelateImage, makeBack, toColorGrid, MAX_IMAGE_PIXELS } = loadTs('src/shared/pixelate.ts');

const W = 18, H = 32;
const idx = (x, y, w = W) => (y * w + x) * 4;

/** RGBA canvas of `w`x`h` filled with `bg` ([r,g,b,a]); `paint(set, box)` draws on it. */
function canvas(w, h, bg, paint) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(bg, i * 4);
  paint((x, y, c) => { if (x >= 0 && y >= 0 && x < w && y < h) data.set(c, idx(x, y, w)); },
    (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < w && y < h) data.set(c, idx(x, y, w)); });
  return { data, width: w, height: h };
}
const WHITE = [255, 255, 255, 255], CLEAR = [0, 0, 0, 0];
const RED = [200, 30, 30, 255], BLUE = [30, 60, 200, 255], SKIN = [250, 215, 175, 255], BLACK = [10, 10, 14, 255], YELLOW = [240, 210, 20, 255];

/** A tall figure: head, torso, two legs, centred, on `bg`. */
function figure(bg, w = 90, h = 160) {
  return canvas(w, h, bg, (_, box) => {
    box(35, 10, 54, 35, SKIN);      // head
    box(30, 38, 59, 100, BLUE);     // torso
    box(30, 70, 59, 76, YELLOW);    // belt accent
    box(33, 100, 43, 150, RED);     // left leg
    box(46, 100, 56, 150, RED);     // right leg
  });
}

const alpha = (buf, x, y) => buf[idx(x, y) + 3];
const colorsOf = (buf) => {
  const s = new Set();
  for (let i = 0; i < buf.length; i += 4) if (buf[i + 3]) s.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);
  return s;
};

test('output is exactly 18x32 front/back and an 18x28 portrait', () => {
  const r = pixelateImage(figure(WHITE));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.front.length, W * H * 4);
  assert.equal(r.value.back.length, W * H * 4);
  assert.equal(r.value.portrait.length, 18 * 28 * 4);
  assert.deepEqual([...r.value.portrait], [...r.value.front.slice(0, 18 * 28 * 4)]);
});

test('a solid background is removed and the subject is bottom-aligned and centred', () => {
  const f = pixelateImage(figure(WHITE)).value.front;
  assert.equal(alpha(f, 0, 0), 0);                   // corner = background
  assert.equal(alpha(f, 17, 0), 0);
  let top = -1, bottom = -1, left = W, right = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha(f, x, y)) {
    if (top < 0) top = y; bottom = y; left = Math.min(left, x); right = Math.max(right, x);
  }
  assert.equal(bottom, H - 1, 'sits on the bottom edge');
  assert.ok(Math.abs((left + right) / 2 - (W - 1) / 2) <= 1, `centred (${left}..${right})`);
  assert.ok(top >= 0 && top < 8, 'uses most of the height');
});

test('background removal works for a coloured background and for transparency', () => {
  for (const bg of [[20, 160, 90, 255], CLEAR]) {
    const f = pixelateImage(figure(bg)).value.front;
    assert.equal(alpha(f, 0, 0), 0, `bg ${bg}`);
    assert.ok(colorsOf(f).size >= 3, 'the figure survives');
  }
});

test('an enclosed region the colour of the background is kept (only the outside is removed)', () => {
  // A red block with a WHITE hole on a WHITE background: the hole must stay opaque white.
  const img = canvas(60, 90, WHITE, (_, box) => { box(10, 10, 49, 79, RED); box(25, 30, 34, 50, WHITE); });
  const f = pixelateImage(img, { fit: 'fill', outline: false, symmetric: false }).value.front;
  // "fill" stretches the subject over the whole frame, so the corner is the red block, not background.
  assert.deepEqual([...f.slice(idx(0, 0), idx(0, 0) + 4)], [200, 30, 30, 255]);
  const hole = f.slice(idx(9, 14), idx(9, 14) + 4);
  assert.deepEqual([...hole], [255, 255, 255, 255]);
  // ...and the white OUTSIDE the block is still removed when it is not stretched over.
  const narrow = canvas(60, 90, WHITE, (_, box) => { box(25, 10, 34, 79, RED); box(28, 30, 31, 50, WHITE); });
  const f2 = pixelateImage(narrow, { outline: false }).value.front;
  assert.equal(alpha(f2, 0, 0), 0);                      // empty margin beside a narrow subject
  assert.ok(colorsOf(f2).has('255,255,255'), 'the enclosed white hole survives');
});

test('palette is capped, and the outline colour is added on top', () => {
  // A smooth gradient has thousands of colours.
  const img = canvas(80, 140, WHITE, (set) => {
    for (let y = 10; y < 130; y++) for (let x = 20; x < 60; x++) set(x, y, [(x * 6) & 255, (y * 2) & 255, ((x + y) * 3) & 255, 255]);
  });
  const r = pixelateImage(img, { maxColors: 8, outline: false });
  assert.equal(r.ok, true, r.error);
  assert.ok(colorsOf(r.value.front).size <= 8, `got ${colorsOf(r.value.front).size}`);
  const withOutline = pixelateImage(img, { maxColors: 8 }).value.front;
  assert.ok(colorsOf(withOutline).size <= 9);
});

test('existing pixel art keeps its exact colours', () => {
  const f = pixelateImage(figure(WHITE), { outline: false }).value.front;
  const c = colorsOf(f);
  for (const want of [RED, BLUE, SKIN, YELLOW]) assert.ok(c.has(`${want[0]},${want[1]},${want[2]}`), `kept ${want}`);
});

test('symmetric mode mirrors exactly; off leaves an asymmetric subject alone', () => {
  const lopsided = canvas(90, 160, WHITE, (_, box) => { box(20, 10, 40, 150, RED); box(41, 10, 70, 80, BLUE); });
  const sym = pixelateImage(lopsided, { symmetric: true }).value.front;
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) {
    assert.deepEqual([...sym.slice(idx(x, y), idx(x, y) + 4)], [...sym.slice(idx(W - 1 - x, y), idx(W - 1 - x, y) + 4)], `row ${y} col ${x}`);
  }
  const free = pixelateImage(lopsided, { symmetric: false }).value.front;
  let differs = false;
  for (let y = 0; y < H && !differs; y++) for (let x = 0; x < W / 2; x++) {
    if (free[idx(x, y)] !== free[idx(W - 1 - x, y)] || free[idx(x, y) + 3] !== free[idx(W - 1 - x, y) + 3]) { differs = true; break; }
  }
  assert.equal(differs, true);
});

test('fit "fill" uses the whole frame, "contain" keeps the aspect', () => {
  const wide = canvas(100, 100, WHITE, (_, box) => box(10, 10, 89, 89, RED));
  const contain = pixelateImage(wide, { outline: false }).value.front;
  const fill = pixelateImage(wide, { outline: false, fit: 'fill' }).value.front;
  const rows = (buf) => { let n = 0; for (let y = 0; y < H; y++) if (alpha(buf, 9, y)) n++; return n; };
  assert.equal(rows(fill), H);
  assert.ok(rows(contain) <= 18, `square stays squarish (${rows(contain)} rows)`);
});

test('an outline is added when the art has none, and not when it already has one', () => {
  const bare = pixelateImage(figure(WHITE)).value.front;
  assert.ok(colorsOf(bare).size >= 5, 'outline colour present');
  // Black-bordered art: the edge is already dark, so no extra outline ring grows it.
  const dark = canvas(60, 90, WHITE, (_, box) => { box(10, 10, 49, 79, BLACK); box(14, 14, 45, 75, RED); });
  const a = pixelateImage(dark, { fit: 'fill', outline: true }).value.front;
  const b = pixelateImage(dark, { fit: 'fill', outline: false }).value.front;
  assert.deepEqual([...a], [...b]);
});

test('the back view hides the face and accent colours but keeps the silhouette', () => {
  const { front, back } = pixelateImage(figure(WHITE), { outline: false }).value;
  const skin = `${SKIN[0]},${SKIN[1]},${SKIN[2]}`, yellow = `${YELLOW[0]},${YELLOW[1]},${YELLOW[2]}`;
  assert.ok(colorsOf(front).has(skin) && colorsOf(front).has(yellow));
  assert.ok(!colorsOf(back).has(skin), 'no skin on the back of the head');
  assert.ok(!colorsOf(back).has(yellow), 'no belt on the back');
  for (let i = 3; i < front.length; i += 4) assert.equal(back[i], front[i], 'same silhouette');
  assert.deepEqual([...makeBack(new Uint8ClampedArray(W * H * 4))], new Array(W * H * 4).fill(0)); // empty in, empty out
});

test('junk input fails cleanly instead of throwing', () => {
  assert.equal(pixelateImage({ data: new Uint8ClampedArray(0), width: 0, height: 0 }).ok, false);
  assert.equal(pixelateImage({ data: new Uint8ClampedArray(8), width: 10, height: 10 }).ok, false);
  assert.equal(pixelateImage({ data: new Uint8ClampedArray(4), width: MAX_IMAGE_PIXELS, height: 2 }).ok, false);
  assert.match(pixelateImage(canvas(40, 40, WHITE, () => {})).error, /no subject/);           // blank
  assert.match(pixelateImage(canvas(40, 40, CLEAR, () => {})).error, /no subject/);           // fully transparent
  // A solid single-colour image cannot be told apart from a blank background: a clean "no subject", not a crash.
  assert.match(pixelateImage(canvas(1, 1, RED, () => {})).error, /no subject/);
  // Extreme aspect ratios with a real subject still produce a sprite.
  assert.equal(pixelateImage(canvas(3, 500, WHITE, (_, box) => box(1, 100, 1, 400, RED))).ok, true);
  assert.equal(pixelateImage(canvas(500, 3, WHITE, (_, box) => box(100, 1, 400, 1, RED))).ok, true);
  assert.equal(pixelateImage(canvas(4, 4, WHITE, (set) => set(1, 1, RED))).ok, true);          // tiny image, single-pixel subject
});

test('toColorGrid describes the sprite as 32 rows of 18 letters with a legend', () => {
  const { front } = pixelateImage(figure(WHITE), { outline: false }).value;
  const g = toColorGrid(front);
  assert.equal(g.rows.length, 32);
  assert.ok(g.rows.every((r) => r.length === 18 && /^[a-y.]+$/.test(r)));
  assert.ok(g.legend.length >= 4 && g.legend.every((l) => /^#[0-9a-f]{6}$/.test(l.hex)));
  assert.equal(g.rows[0][0], '.');
  assert.equal(g.rows.join('').includes('?'), false);
});
