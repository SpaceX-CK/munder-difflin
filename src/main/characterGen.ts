/**
 * AI pixel-art characters: ask a hidden Claude session to draw the sprite as SVG,
 * then run the reply through the strict sanitizer in shared/characterSvg.ts.
 *
 * Two entry points share one drawing loop:
 *   - generateCharacterSvgs(description): draw from a text description.
 *   - generateFromImage(bytes, ...): redraw a reference image (the session looks at it
 *     with the Read tool), optionally guided by the deterministic Pixelate draft.
 *
 * Uses runHiddenClaude (an ephemeral interactive PTY), so it draws on the user's
 * normal Claude plan and needs no API key. The session gets no file-write, shell or
 * network tools; for the image path `Read` stays available, but the session's working
 * directory holds only that one image and the reply is rebuilt from <rect>s by the
 * sanitizer, so nothing from the model (or from text hidden in the image) is passed on.
 *
 * WORKING DIRECTORY: Claude Code asks "do you trust this folder?" in any new directory
 * and a hidden session cannot answer, so it would just die. The caller passes the
 * harness home, where the god agent already runs (trusted); the image path uses a
 * throw-away subfolder of it, which inherits that trust.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_IMAGE_BYTES, buildCharacterPrompt, buildImagePrompt, cleanDescription, parseGeneratedSprites, validateLayoutGrid,
  type LayoutGrid
} from '../shared/characterSvg';
export { MAX_IMAGE_BYTES };
import type { HiddenClaudeOptions, HiddenClaudeResult } from './hiddenClaude';

/** Alias the CLI resolves to the current Sonnet; better line-work (and vision) than Haiku. */
export const CHARACTER_GEN_MODEL = 'sonnet';
/** A bad drawing is retried once with the rejection reason fed back. */
export const MAX_ATTEMPTS = 2;
const TIMEOUT_MS = 180_000;
/** Silence that ends a turn. Startup hooks / MCP servers can leave multi-second gaps. */
const IDLE_MS = 8_000;
/** Where throw-away reference-image folders live, inside the trusted harness home. */
export const GEN_DIR = '.character-gen';

/** The tools a drawing session must never have. `Read` is deliberately NOT listed (image path). */
const BLOCKED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];

export type RunClaude = (prompt: string, opts: HiddenClaudeOptions) => Promise<HiddenClaudeResult>;

export interface GenerateDeps {
  /** Injected in tests; defaults to the real hidden-claude runner (lazy-loaded so node-pty stays out of tests). */
  run?: RunClaude;
  /** The claude binary/command (config.defaultCommand). */
  command?: string;
  /** A TRUSTED existing directory: the harness home. Required (see the header comment). */
  cwd?: string;
}

export type GenerateResult =
  | { ok: true; front: string; back: string }
  | { ok: false; error: string };

export type ImageExt = 'png' | 'jpg' | 'gif' | 'webp';

/** Identify an image by its magic bytes (never trust a filename or MIME type from the renderer). */
export function sniffImageType(b: Uint8Array): ImageExt | null {
  const at = (i: number): number => b[i] ?? -1;
  if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'png';
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpg';
  if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return 'gif';
  if (b.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'webp';
  return null;
}

// One drawing at a time: each is a full Claude session, and the UI has one busy state.
let busy = false;

const NEEDS_TRUST = /no assistant response/i;

/** The shared loop: run, sanitize, retry once with the reason fed back. */
async function drawWithClaude(basePrompt: string, cwd: string, deps: GenerateDeps): Promise<GenerateResult> {
  const run = deps.run ?? (await import('./hiddenClaude')).runHiddenClaude;
  let prompt = basePrompt;
  let lastError = 'no reply';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await run(prompt, {
      model: CHARACTER_GEN_MODEL,
      cwd,
      command: deps.command,
      disallowedTools: BLOCKED_TOOLS,
      idleMs: IDLE_MS,
      timeoutMs: TIMEOUT_MS
    });
    if (!res.ok || !res.text) {
      lastError = res.error ?? 'Claude returned nothing';
      continue;
    }
    const parsed = parseGeneratedSprites(res.text);
    if (parsed.ok) return { ok: true, ...parsed.value };
    lastError = parsed.error;
    // Tell the model what was wrong so the retry converges instead of repeating.
    prompt = `${basePrompt}\n\nYour previous reply was rejected: ${parsed.error}. Follow the rules exactly.`;
  }
  const hint = NEEDS_TRUST.test(lastError)
    ? ' Claude may be waiting on a folder-trust prompt: start the god agent once in this harness, then retry.'
    : ' Try a simpler description or image.';
  return { ok: false, error: `Could not get a usable drawing (${lastError}).${hint}` };
}

function workDir(deps: GenerateDeps): string | null {
  return deps.cwd && existsSync(deps.cwd) ? deps.cwd : null;
}

export async function generateCharacterSvgs(description: string, deps: GenerateDeps = {}): Promise<GenerateResult> {
  if (!cleanDescription(description)) return { ok: false, error: 'Describe the character first.' };
  const cwd = workDir(deps);
  if (!cwd) return { ok: false, error: 'Pick a harness home first (Settings); drawing runs there.' };
  if (busy) return { ok: false, error: 'Already drawing a character; wait for it to finish.' };
  busy = true;
  try {
    return await drawWithClaude(buildCharacterPrompt(description), cwd, deps);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    busy = false;
  }
}

export interface ImageRequest {
  bytes: Uint8Array;
  /** Optional free-text note ("make the cape longer"). */
  hint?: string;
  /** Optional Pixelate draft (validated here; anything malformed is dropped, not trusted). */
  layout?: unknown;
}

export async function generateFromImage(req: ImageRequest, deps: GenerateDeps = {}): Promise<GenerateResult> {
  if (!(req.bytes instanceof Uint8Array) || req.bytes.length === 0) return { ok: false, error: 'No image was provided.' };
  if (req.bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `That image is too large (max ${Math.round(MAX_IMAGE_BYTES / 1048576)} MB).` };
  const ext = sniffImageType(req.bytes);
  if (!ext) return { ok: false, error: 'That does not look like a PNG, JPEG, GIF or WebP image.' };
  const cwd = workDir(deps);
  if (!cwd) return { ok: false, error: 'Pick a harness home first (Settings); drawing runs there.' };
  if (busy) return { ok: false, error: 'Already drawing a character; wait for it to finish.' };
  busy = true;
  const root = join(cwd, GEN_DIR);
  let runDir: string | null = null;
  try {
    mkdirSync(root, { recursive: true });
    runDir = mkdtempSync(join(root, 'run-'));
    const refFile = `reference.${ext}`; // a fixed name: nothing from the renderer reaches a path or the prompt
    writeFileSync(join(runDir, refFile), req.bytes);
    const layout: LayoutGrid | null = validateLayoutGrid(req.layout);
    return await drawWithClaude(buildImagePrompt(refFile, req.hint, layout), runDir, deps);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (runDir) { try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    try { rmdirSync(root); } catch { /* not empty (another run) or already gone */ }
    busy = false;
  }
}
