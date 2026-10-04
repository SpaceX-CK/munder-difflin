/**
 * User-made office characters — the data model, validation, and the export file
 * format. Pure (no Electron / DOM), so main, the renderer and tests share it.
 *
 * A character is either a **recipe** (the same knobs the shipped cast is drawn
 * from: skin, hair, outfit…) or **pixels** (ready-made RGBA art, e.g. AI-generated
 * from an SVG). Both end up as the sprite frames the office scene already plays:
 * 18×32 front + back, plus an 18×28 portrait.
 *
 * Everything that crosses a trust boundary (an imported .mdchar.json, a hire
 * manifest, the AI sanitizer's output) goes through `validateCustomCharacter`.
 */

export const CUSTOM_ID_PREFIX = 'custom:';
export const SCENE_W = 18;
export const SCENE_H = 32;
export const PORTRAIT_W = 18;
export const PORTRAIT_H = 28;
export const NAME_MAX = 24;
export const CHARACTER_FILE_VERSION = 1;
/** Hard cap on an imported file, well above a legitimate one (~9 KB). */
export const CHARACTER_FILE_MAX_BYTES = 64 * 1024;

// Option vocabularies. portraitArt.ts re-exports these and type-checks them
// against its drawing tables, so a typo here fails the build rather than the draw.
export const SKIN_TONES = ['light', 'tan', 'brown', 'dark'] as const;
export const HAIR_STYLES = [
  'styleShort', 'styleFloppy', 'styleFrame', 'styleBun', 'styleCurly',
  'styleMessy', 'styleRecede', 'styleSpiky', 'styleBald'
] as const;
export const CLOTH_KINDS = ['suit', 'dressshirt', 'polo', 'blouse', 'cardigan', 'sweater'] as const;
export const FACIAL_KINDS = ['mustache', 'mustacheSm', 'stubble', 'goatee'] as const;
export const BROW_KINDS = ['flat', 'angry', 'raised', 'soft'] as const;
export const MOUTH_KINDS = ['neutral', 'smile', 'frown', 'grin'] as const;

export type RGB3 = [number, number, number];

export interface RecipeData {
  skin: (typeof SKIN_TONES)[number];
  hairc: RGB3;
  hair: (typeof HAIR_STYLES)[number];
  hairargs?: { part?: 'L' | 'R'; recede?: number; length?: number; vol?: number };
  cloth: (typeof CLOTH_KINDS)[number];
  c1: RGB3;
  c2?: RGB3;
  tie?: RGB3;
  pants?: RGB3;
  brow?: (typeof BROW_KINDS)[number];
  mouth?: (typeof MOUTH_KINDS)[number];
  blush?: boolean;
  facial?: (typeof FACIAL_KINDS)[number];
  glasses?: boolean;
  lashes?: boolean;
  heavy?: boolean;
}

/** Base64 RGBA buffers: front/back are 18×32, portrait is 18×28. */
export interface PixelData { front: string; back: string; portrait: string }

export type CustomCharacterId = `${typeof CUSTOM_ID_PREFIX}${string}`;

export interface CustomCharacter {
  id: CustomCharacterId;
  displayName: string;
  kind: 'recipe' | 'pixels';
  recipe?: RecipeData;
  pixels?: PixelData;
  /** Short line shown in the picker (optional). */
  blurb?: string;
  createdAt: number;
}

/** The export/import envelope — a single character, versioned. */
export interface CharacterFile { version: typeof CHARACTER_FILE_VERSION; character: CustomCharacter }

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const ID_RE = /^custom:[a-z0-9][a-z0-9-]{0,23}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Lowercase, dash-separated, ≤ 24 chars; '' when nothing usable remains. */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX).replace(/-+$/g, '');
}

/** A `custom:` id for `name` that does not collide with `taken`. */
export function makeCustomId(name: string, taken: Iterable<string>): CustomCharacterId {
  const used = new Set(taken);
  const base = slugify(name) || 'character';
  let id = `${CUSTOM_ID_PREFIX}${base}`;
  for (let n = 2; used.has(id); n++) {
    const suffix = `-${n}`;
    id = `${CUSTOM_ID_PREFIX}${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
  }
  return id as CustomCharacterId;
}

/** Decoded byte length of a base64 string, or -1 if it isn't well-formed base64. */
export function base64ByteLength(b64: string): number {
  if (b64.length === 0 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return -1;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function pickEnum<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

function rgb(v: unknown): RGB3 | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  const out = v.map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : NaN));
  return out.some(Number.isNaN) ? undefined : (out as RGB3);
}

const clampInt = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : undefined;

function validateRecipe(raw: unknown): Validated<RecipeData> {
  if (!isObj(raw)) return { ok: false, error: 'recipe must be an object' };
  const skin = pickEnum(raw.skin, SKIN_TONES);
  const hair = pickEnum(raw.hair, HAIR_STYLES);
  const cloth = pickEnum(raw.cloth, CLOTH_KINDS);
  const hairc = rgb(raw.hairc);
  const c1 = rgb(raw.c1);
  if (!skin) return { ok: false, error: 'recipe.skin is not a known skin tone' };
  if (!hair) return { ok: false, error: 'recipe.hair is not a known hair style' };
  if (!cloth) return { ok: false, error: 'recipe.cloth is not a known outfit' };
  if (!hairc) return { ok: false, error: 'recipe.hairc must be [r,g,b]' };
  if (!c1) return { ok: false, error: 'recipe.c1 must be [r,g,b]' };
  const out: RecipeData = { skin, hairc, hair, cloth, c1 };
  for (const k of ['c2', 'tie', 'pants'] as const) {
    if (raw[k] === undefined) continue;
    const c = rgb(raw[k]);
    if (!c) return { ok: false, error: `recipe.${k} must be [r,g,b]` };
    out[k] = c;
  }
  const brow = pickEnum(raw.brow, BROW_KINDS);
  const mouth = pickEnum(raw.mouth, MOUTH_KINDS);
  const facial = pickEnum(raw.facial, FACIAL_KINDS);
  if (brow) out.brow = brow;
  if (mouth) out.mouth = mouth;
  if (facial) out.facial = facial;
  for (const k of ['blush', 'glasses', 'lashes', 'heavy'] as const) if (raw[k] === true) out[k] = true;
  if (isObj(raw.hairargs)) {
    const a = raw.hairargs;
    const ha: NonNullable<RecipeData['hairargs']> = {};
    if (a.part === 'L' || a.part === 'R') ha.part = a.part;
    const recede = clampInt(a.recede, 0, 4);
    const length = clampInt(a.length, 0, 28);
    const vol = clampInt(a.vol, 0, 4);
    if (recede !== undefined) ha.recede = recede;
    if (length !== undefined) ha.length = length;
    if (vol !== undefined) ha.vol = vol;
    if (Object.keys(ha).length) out.hairargs = ha;
  }
  return { ok: true, value: out };
}

function validatePixels(raw: unknown): Validated<PixelData> {
  if (!isObj(raw)) return { ok: false, error: 'pixels must be an object' };
  const want = { front: SCENE_W * SCENE_H * 4, back: SCENE_W * SCENE_H * 4, portrait: PORTRAIT_W * PORTRAIT_H * 4 };
  const out = {} as PixelData;
  for (const k of ['front', 'back', 'portrait'] as const) {
    const v = raw[k];
    if (typeof v !== 'string') return { ok: false, error: `pixels.${k} must be a base64 string` };
    const n = base64ByteLength(v);
    if (n !== want[k]) return { ok: false, error: `pixels.${k} must decode to ${want[k]} bytes (got ${n})` };
    out[k] = v;
  }
  return { ok: true, value: out };
}

/** Validate + normalize one character. Unknown fields are dropped, not kept. */
export function validateCustomCharacter(raw: unknown): Validated<CustomCharacter> {
  if (!isObj(raw)) return { ok: false, error: 'character must be an object' };
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return { ok: false, error: `id must look like "custom:my-name" (a-z, 0-9, dashes, ≤ ${NAME_MAX} chars)` };
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim().slice(0, NAME_MAX) : '';
  if (!displayName) return { ok: false, error: 'displayName is required' };
  if (raw.kind !== 'recipe' && raw.kind !== 'pixels') return { ok: false, error: 'kind must be "recipe" or "pixels"' };
  const out: CustomCharacter = {
    id: raw.id as CustomCharacterId,
    displayName,
    kind: raw.kind,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  };
  if (typeof raw.blurb === 'string' && raw.blurb.trim()) out.blurb = raw.blurb.trim().slice(0, 80);
  if (raw.kind === 'recipe') {
    const r = validateRecipe(raw.recipe);
    if (!r.ok) return r;
    out.recipe = r.value;
  } else {
    const p = validatePixels(raw.pixels);
    if (!p.ok) return p;
    out.pixels = p.value;
  }
  return { ok: true, value: out };
}

export function toCharacterFile(character: CustomCharacter): CharacterFile {
  return { version: CHARACTER_FILE_VERSION, character };
}

/** Parse the text of an imported .mdchar.json. Never throws. */
export function parseCharacterFile(text: string): Validated<CustomCharacter> {
  if (text.length > CHARACTER_FILE_MAX_BYTES) return { ok: false, error: 'file is too large to be a character' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'not valid JSON' }; }
  if (!isObj(raw) || raw.version !== CHARACTER_FILE_VERSION) return { ok: false, error: 'unsupported character file version' };
  return validateCustomCharacter(raw.character);
}
