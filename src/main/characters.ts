/**
 * On-disk store for user-made characters: one validated JSON file per character
 * under <userData>/characters/. Electron-free (the directory is injected) so it is
 * testable off-process; the dialogs for export/import live in index.ts.
 *
 * Every file read back is re-validated, so a hand-edited or corrupt file is
 * skipped rather than trusted, and the filename comes only from a validated id
 * (`custom:<[a-z0-9-]+>`), so a character can never write outside this directory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHARACTER_FILE_MAX_BYTES, CUSTOM_ID_PREFIX, makeCustomId, parseCharacterFile, toCharacterFile,
  validateCustomCharacter, type CustomCharacter, type Validated
} from '../shared/customCharacter';

/** Plenty for a hand-made roster; stops a runaway import loop filling the disk. */
export const MAX_CHARACTERS = 100;

/** Same shape `validateCustomCharacter` enforces on `id`; gates every filename. */
const SAFE_ID = /^custom:[a-z0-9][a-z0-9-]{0,23}$/;

export class CharacterStore {
  constructor(private readonly dir: () => string) {}

  private fileFor(id: string): string {
    return join(this.dir(), `${id.slice(CUSTOM_ID_PREFIX.length)}.json`);
  }

  list(): CustomCharacter[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    const out: CustomCharacter[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).size > CHARACTER_FILE_MAX_BYTES) continue;
        const v = validateCustomCharacter(JSON.parse(readFileSync(p, 'utf8')));
        // The file's name must match its id, or two files could claim one character.
        if (v.ok && this.fileFor(v.value.id) === p) out.push(v.value);
      } catch { /* unreadable or corrupt: skip */ }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): CustomCharacter | null {
    return this.list().find((c) => c.id === id) ?? null;
  }

  /** Validate and persist (create or replace). Atomic: write a temp file, then rename. */
  save(raw: unknown): Validated<CustomCharacter> {
    const v = validateCustomCharacter(raw);
    if (!v.ok) return v;
    const dir = this.dir();
    const replacing = existsSync(this.fileFor(v.value.id));
    if (!replacing && this.list().length >= MAX_CHARACTERS) {
      return { ok: false, error: `character limit reached (${MAX_CHARACTERS}); delete one first` };
    }
    try {
      mkdirSync(dir, { recursive: true });
      const target = this.fileFor(v.value.id);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(v.value));
      renameSync(tmp, target);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return v;
  }

  remove(id: string): boolean {
    if (!SAFE_ID.test(id)) return false;
    const p = this.fileFor(id);
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  }

  /** The text to write for an export of `id`, or null if there is no such character. */
  exportText(id: string): string | null {
    const c = this.get(id);
    return c ? JSON.stringify(toCharacterFile(c), null, 2) : null;
  }

  /**
   * Import a character file's text. The imported character always gets a FRESH id
   * derived from its name, so importing can never overwrite one you already have.
   */
  importText(text: string): Validated<CustomCharacter> {
    const parsed = parseCharacterFile(text);
    if (!parsed.ok) return parsed;
    const id = makeCustomId(parsed.value.displayName, this.list().map((c) => c.id));
    return this.save({ ...parsed.value, id, createdAt: Date.now() });
  }
}
