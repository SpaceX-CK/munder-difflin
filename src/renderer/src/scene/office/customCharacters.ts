// Runtime registry for user-made characters.
//
// Main owns the files (<userData>/characters/*.json); this module mirrors them into
// the renderer: it registers each one's art with portraitArt (so frames/portraits
// resolve by id like the shipped cast) and adds a CastMember to CAST_BY_NAME (the
// object the theme's `cast.byName` points at, so OfficeFloor's lookup finds it).
// The zustand store feeds the pickers and the studio.

import { create } from 'zustand';
import type { CustomCharacter } from '@shared/customCharacter';
import type { RgbaImage } from '@shared/pixelate';
import { PORTRAIT_H, PORTRAIT_W, SCENE_H, SCENE_W } from '@shared/customCharacter';
import { CAST_BY_NAME, invalidateCastFrames, type CastMember } from './cast';
import { registerCustomArt, unregisterCustomArt, type Recipe } from './portraitArt';

export function b64ToBuf(b64: string): Uint8ClampedArray {
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bufToB64(buf: Uint8ClampedArray): string {
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const WANT = { scene: SCENE_W * SCENE_H * 4, portrait: PORTRAIT_W * PORTRAIT_H * 4 };

/** Accent used for the in-scene selection glow of a custom character. */
function accentOf(c: CustomCharacter): string {
  const rgb = c.recipe?.c1;
  if (!rgb) return '#8aa4c8';
  return '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** Register one character with the scene + cast. Safe to call again to replace it. */
export function applyCustomCharacter(c: CustomCharacter): void {
  if (c.kind === 'recipe' && c.recipe) {
    registerCustomArt(c.id, { recipe: c.recipe as Recipe });
  } else if (c.kind === 'pixels' && c.pixels) {
    const front = b64ToBuf(c.pixels.front);
    const back = b64ToBuf(c.pixels.back);
    const portrait = b64ToBuf(c.pixels.portrait);
    if (front.length !== WANT.scene || back.length !== WANT.scene || portrait.length !== WANT.portrait) return;
    registerCustomArt(c.id, { pixels: { front, back, portrait } });
  } else {
    return;
  }
  const member: CastMember = {
    name: c.id as unknown as CastMember['name'],
    displayName: c.displayName,
    shirt: accentOf(c),
    blurb: c.blurb ?? 'Custom character'
  };
  (CAST_BY_NAME as Record<string, CastMember>)[c.id] = member;
  invalidateCastFrames(c.id);
}

export function removeCustomCharacter(id: string): void {
  unregisterCustomArt(id);
  delete (CAST_BY_NAME as Record<string, CastMember>)[id];
  invalidateCastFrames(id);
}

interface CustomCharacterState {
  characters: CustomCharacter[];
  loaded: boolean;
  /** Bump after any change so picker/portrait components repaint (art mutates in place). */
  rev: number;
  load: () => Promise<void>;
  save: (c: CustomCharacter) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: string) => Promise<void>;
  /** Add a character main already persisted (import path). */
  adopt: (c: CustomCharacter) => void;
}

export const useCustomCharacters = create<CustomCharacterState>((set, get) => ({
  characters: [],
  loaded: false,
  rev: 0,
  async load() {
    const list = (await window.cth.characters?.list?.().catch(() => [])) ?? [];
    for (const c of list) applyCustomCharacter(c);
    set((s) => ({ characters: list, loaded: true, rev: s.rev + 1 }));
  },
  async save(c) {
    const res = await window.cth.characters.save(c);
    if (!res.ok) return res;
    get().adopt(c);
    return { ok: true };
  },
  async remove(id) {
    await window.cth.characters.delete(id);
    removeCustomCharacter(id);
    set((s) => ({ characters: s.characters.filter((c) => c.id !== id), rev: s.rev + 1 }));
  },
  adopt(c) {
    applyCustomCharacter(c);
    set((s) => ({
      characters: [...s.characters.filter((x) => x.id !== c.id), c].sort((a, b) => a.createdAt - b.createdAt),
      rev: s.rev + 1
    }));
  }
}));

let loadPromise: Promise<void> | null = null;
/** Load once (memoized). The scene awaits this before resolving a roster entry's
 *  character, so agents restored at startup don't get the default sprite. */
export const loadCustomCharacters = (): Promise<void> => (loadPromise ??= useCustomCharacters.getState().load());

/**
 * Rasterize a sanitized SVG (rect-only, produced by main's characterGen) to RGBA at
 * 1:1 on an offscreen canvas. No smoothing: the SVG's rects are pixel-aligned.
 */
export function rasterizeSvg(svg: string, w: number, h: number): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { reject(new Error('no 2d context')); return; }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, w, h);
      resolve(new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data));
    };
    img.onerror = () => reject(new Error('could not render the generated SVG'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/**
 * Decode an image file to RGBA for Pixelate. Sprites stay pixel-exact (no smoothing at
 * native size); anything over 1024px on its long side is shrunk first so photos stay fast.
 */
export async function decodeImage(blob: Blob): Promise<RgbaImage> {
  const bmp = await createImageBitmap(blob);
  try {
    const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.imageSmoothingEnabled = s < 1;
    ctx.drawImage(bmp, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  } finally {
    bmp.close?.();
  }
}

/** Crop the 18×28 portrait out of an 18×32 front sprite (drop the bottom 4 rows = feet). */
export function portraitFromFront(front: Uint8ClampedArray): Uint8ClampedArray {
  return new Uint8ClampedArray(front.subarray(0, PORTRAIT_W * PORTRAIT_H * 4));
}
