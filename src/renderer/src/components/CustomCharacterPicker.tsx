import { useState } from 'react';
import { SpritePortrait } from './SpritePortrait';
import { CharacterStudio } from './CharacterStudio';
import { useCustomCharacters } from '@/scene/office/customCharacters';
import type { CustomCharacter } from '@shared/customCharacter';
import type { CharacterId } from '@/scene/office/cast';

export interface CustomCharacterPickerProps {
  selected: string;
  accent: string;
  /** Tile + portrait sizing so it matches the surrounding picker. */
  tileWidth: number;
  portraitScale: number;
  onPick: (id: CharacterId, displayName: string) => void;
}

/**
 * The user-made tiles plus a "+ Custom" tile, appended after the shipped cast in
 * the Add / Edit agent pickers. Hover a custom tile to edit or delete it.
 */
export function CustomCharacterPicker({ selected, accent, tileWidth, portraitScale, onPick }: CustomCharacterPickerProps) {
  const characters = useCustomCharacters((s) => s.characters);
  const remove = useCustomCharacters((s) => s.remove);
  const [studio, setStudio] = useState<{ editing?: CustomCharacter } | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const h = Math.round(portraitScale * 28);
  const w = Math.round(portraitScale * 18) + 8;

  return (
    <>
      {characters.map((c) => {
        const active = selected === c.id;
        return (
          <div
            key={c.id}
            onMouseEnter={() => setHover(c.id)}
            onMouseLeave={() => setHover((x) => (x === c.id ? null : x))}
            style={{ position: 'relative' }}
          >
            <button
              type="button"
              onClick={() => onPick(c.id, c.displayName)}
              title={c.blurb ?? 'Custom character'}
              style={{
                padding: 4,
                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
                cursor: 'pointer', border: 'none', width: tileWidth,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2
              }}
            >
              <div style={{ width: w, height: h, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden' }}>
                <SpritePortrait character={c.id} scale={portraitScale} />
              </div>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-700)', maxWidth: tileWidth - 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.displayName}</span>
            </button>
            {hover === c.id && (
              <div style={{ position: 'absolute', top: 0, right: 0, display: 'flex', gap: 2 }}>
                <MiniButton label="edit" onClick={() => setStudio({ editing: c })}>✎</MiniButton>
                <MiniButton label="delete" onClick={() => { if (window.confirm(`Delete custom character "${c.displayName}"? Agents using it fall back to the default look.`)) void remove(c.id); }}>×</MiniButton>
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setStudio({})}
        title="Design a character, or have AI draw one"
        style={{
          padding: 4, width: tileWidth, cursor: 'pointer', border: 'none',
          background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2
        }}
      >
        <span style={{ fontSize: 24, lineHeight: `${h}px`, color: 'var(--cth-ink-500)' }}>+</span>
        <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>Custom</span>
      </button>
      {studio && (
        <CharacterStudio
          editing={studio.editing}
          onClose={() => setStudio(null)}
          onSaved={(c) => onPick(c.id, c.displayName)}
        />
      )}
    </>
  );
}

function MiniButton({ children, label, onClick }: { children: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ width: 16, height: 16, padding: 0, lineHeight: '14px', fontSize: 12, border: 'none', cursor: 'pointer', background: 'var(--cth-ink-900)', color: 'var(--cth-cream-50)' }}
    >
      {children}
    </button>
  );
}
