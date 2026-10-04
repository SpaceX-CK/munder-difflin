import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import {
  renderRecipe, type Recipe,
  SKIN_TONES, HAIR_STYLES, CLOTH_KINDS, FACIAL_KINDS, BROW_KINDS, MOUTH_KINDS
} from '@/scene/office/portraitArt';
import {
  useCustomCharacters, bufToB64, b64ToBuf, rasterizeSvg, portraitFromFront, decodeImage
} from '@/scene/office/customCharacters';
import { pixelateImage, toColorGrid, type RgbaImage } from '@shared/pixelate';
import { MAX_IMAGE_BYTES } from '@shared/characterSvg';
import {
  makeCustomId, NAME_MAX, SCENE_W, SCENE_H, PORTRAIT_W, PORTRAIT_H,
  type CustomCharacter, type RecipeData
} from '@shared/customCharacter';

const WALK_ORDER = [0, 1, 0, 2];

const DEFAULT_RECIPE: RecipeData = {
  skin: 'light', hairc: [92, 60, 34], hair: 'styleShort', cloth: 'dressshirt',
  c1: [110, 150, 200], tie: [120, 130, 150], brow: 'flat', mouth: 'smile'
};

const hex = (c: [number, number, number]): string => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
const unhex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)
];

/** Draws one RGBA buffer, nearest-neighbor, at `scale`. */
function BufCanvas({ buf, w, h, scale }: { buf: Uint8ClampedArray | null; w: number; h: number; scale: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!buf) return;
    const stage = document.createElement('canvas');
    stage.width = w; stage.height = h;
    const sctx = stage.getContext('2d')!;
    const img = sctx.createImageData(w, h);
    img.data.set(buf);
    sctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(stage, 0, 0, w, h, 0, 0, w * scale, h * scale);
  }, [buf, w, h, scale]);
  return <canvas ref={ref} width={w * scale} height={h * scale} style={{ width: w * scale, height: h * scale, imageRendering: 'pixelated' }} />;
}

interface AiResult { front: Uint8ClampedArray; back: Uint8ClampedArray; portrait: Uint8ClampedArray }

export interface CharacterStudioProps {
  /** Existing character to edit; omit to create a new one. */
  editing?: CustomCharacter;
  onClose: () => void;
  /** Called after a successful save (or import) with the stored character. */
  onSaved?: (c: CustomCharacter) => void;
}

/** Design a character from recipe options, or have Claude draw one as pixel art. */
export function CharacterStudio({ editing, onClose, onSaved }: CharacterStudioProps) {
  const existing = useCustomCharacters((s) => s.characters);
  const save = useCustomCharacters((s) => s.save);
  const adopt = useCustomCharacters((s) => s.adopt);

  const [tab, setTab] = useState<'design' | 'ai'>(editing?.kind === 'pixels' ? 'ai' : 'design');
  const [name, setName] = useState(editing?.displayName ?? '');
  const [recipe, setRecipe] = useState<RecipeData>(editing?.recipe ?? DEFAULT_RECIPE);
  const [prompt, setPrompt] = useState('');
  const [ai, setAi] = useState<AiResult | null>(
    editing?.kind === 'pixels' && editing.pixels
      ? { front: b64ToBuf(editing.pixels.front), back: b64ToBuf(editing.pixels.back), portrait: b64ToBuf(editing.pixels.portrait) }
      : null
  );
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(editing?.id ?? null);
  const [frame, setFrame] = useState(0);
  // Reference image (Pixelate / AI redraw). `source` remembers where the preview came from so the
  // option controls re-run Pixelate live without ever overwriting an AI drawing.
  const [image, setImage] = useState<{ blob: Blob; img: RgbaImage; url: string } | null>(null);
  const [source, setSource] = useState<'pixelate' | 'ai' | null>(null);
  const [mirror, setMirror] = useState(true);
  const [fillFrame, setFillFrame] = useState(false);
  const [tolerance, setTolerance] = useState(40);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const rendered = useMemo(() => renderRecipe(recipe as Recipe), [recipe]);

  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % WALK_ORDER.length), 220);
    return () => clearInterval(t);
  }, []);

  const patch = (p: Partial<RecipeData>) => setRecipe((r) => ({ ...r, ...p }));

  type SvgReply = { ok: boolean; front?: string; back?: string; error?: string };
  const applyDrawing = async (res: SvgReply): Promise<void> => {
    if (!res.ok || !res.front || !res.back) { setError(res.error ?? 'Generation failed'); return; }
    const [front, back] = await Promise.all([
      rasterizeSvg(res.front, SCENE_W, SCENE_H), rasterizeSvg(res.back, SCENE_W, SCENE_H)
    ]);
    setAi({ front, back, portrait: portraitFromFront(front) });
    setSource('ai');
  };

  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true); setError(null);
    try {
      await applyDrawing(await window.cth.characters.generate(prompt.trim()));
      if (!name.trim()) setName(prompt.trim().slice(0, NAME_MAX));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const loadImage = async (blob: Blob, label: string) => {
    setError(null);
    if (!blob.type.startsWith('image/')) { setError('That file is not an image.'); return; }
    if (blob.size > MAX_IMAGE_BYTES) { setError('That image is over 5 MB; pick a smaller one.'); return; }
    try {
      const img = await decodeImage(blob);
      setImage({ blob, img, url: URL.createObjectURL(blob) });
      setSource(null);
      if (!name.trim()) setName(label.replace(/\.[^.]+$/, '').slice(0, NAME_MAX));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that image.');
    }
  };

  const pixelOptions = () => ({ symmetric: mirror, fit: fillFrame ? ('fill' as const) : ('contain' as const), bgTolerance: tolerance });

  const runPixelate = () => {
    if (!image) return;
    const r = pixelateImage(image.img, pixelOptions());
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    setAi(r.value);
    setSource('pixelate');
  };

  const aiRedraw = async () => {
    if (!image || generating) return;
    setGenerating(true); setError(null);
    try {
      // The mechanical shrink goes along as a layout guide, so Claude refines known proportions.
      const draft = pixelateImage(image.img, pixelOptions());
      const bytes = new Uint8Array(await image.blob.arrayBuffer());
      await applyDrawing(await window.cth.characters.generateFromImage({
        bytes, hint: prompt.trim() || undefined, layout: draft.ok ? toColorGrid(draft.value.front) : undefined
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  // Tuning the options re-runs Pixelate live (only over a Pixelate result).
  useEffect(() => { if (source === 'pixelate') runPixelate(); }, [mirror, fillFrame, tolerance]); // eslint-disable-line react-hooks/exhaustive-deps

  // Free the thumbnail's object URL when the image changes or the studio closes.
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  // Paste an image from the clipboard (screenshots included). Plain-text pastes are left alone.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith('image/'));
      if (!f) return;
      e.preventDefault();
      setTab('ai');
      void loadImage(f, f.name || 'pasted');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const buildCharacter = (): CustomCharacter | null => {
    const displayName = name.trim().slice(0, NAME_MAX);
    if (!displayName) { setError('Give your character a name first.'); return null; }
    const id = editing?.id ?? (savedId as CustomCharacter['id'] | null) ?? makeCustomId(displayName, existing.map((c) => c.id));
    const base = { id, displayName, createdAt: editing?.createdAt ?? Date.now() };
    if (tab === 'ai') {
      if (!ai) { setError('Generate (or keep) some art first.'); return null; }
      return { ...base, kind: 'pixels', pixels: { front: bufToB64(ai.front), back: bufToB64(ai.back), portrait: bufToB64(ai.portrait) } };
    }
    return { ...base, kind: 'recipe', recipe };
  };

  const doSave = async (): Promise<CustomCharacter | null> => {
    setError(null);
    const c = buildCharacter();
    if (!c) return null;
    const res = await save(c);
    if (!res.ok) { setError(res.error ?? 'Could not save'); return null; }
    setSavedId(c.id);
    onSaved?.(c);
    return c;
  };

  const doExport = async () => {
    // Export what is on screen: save first so the file matches the preview.
    const c = await doSave();
    if (!c) return;
    const res = await window.cth.characters.export(c.id);
    if (!res.ok && !res.canceled) setError(res.error ?? 'Export failed');
  };

  const doImport = async () => {
    setError(null);
    const res = await window.cth.characters.import();
    if (res.canceled) return;
    if (!res.ok || !res.character) { setError(res.error ?? 'Import failed'); return; }
    adopt(res.character);
    onSaved?.(res.character);
    onClose();
  };

  const previewFront = tab === 'ai' ? (ai ? ai.front : null) : rendered.scene.front[WALK_ORDER[frame]];
  const previewBack = tab === 'ai' ? (ai ? ai.back : null) : rendered.scene.back[WALK_ORDER[frame]];
  const previewPortrait = tab === 'ai' ? (ai ? ai.portrait : null) : rendered.portrait;

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(26, 19, 32, 0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 760, maxWidth: '95vw' }}>
        <PixelPanel variant="dialog" title={editing ? 'EDIT CHARACTER' : 'CHARACTER STUDIO'} style={{ padding: 16 }} noPadding>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16, maxHeight: '86vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <PixelButton size="sm" variant={tab === 'design' ? 'primary' : 'secondary'} onClick={() => setTab('design')}>Design</PixelButton>
              <PixelButton size="sm" variant={tab === 'ai' ? 'primary' : 'secondary'} onClick={() => setTab('ai')}>AI pixel art</PixelButton>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
              {/* Live preview */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <BufCanvas buf={previewFront} w={SCENE_W} h={SCENE_H} scale={4} />
                  <BufCanvas buf={previewBack} w={SCENE_W} h={SCENE_H} scale={2} />
                </div>
                <BufCanvas buf={previewPortrait} w={PORTRAIT_W} h={PORTRAIT_H} scale={3} />
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>front · back · card</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
                <Row label="Name">
                  <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Dana" style={inputStyle} autoFocus />
                </Row>

                {tab === 'design' ? (
                  <>
                    <Row label="Skin"><Chips options={SKIN_TONES} value={recipe.skin} onPick={(skin) => patch({ skin })} /></Row>
                    <Row label="Hair"><Chips options={HAIR_STYLES} value={recipe.hair} label={(s) => s.replace('style', '')} onPick={(hair) => patch({ hair })} /></Row>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                      <Color label="Hair color" value={recipe.hairc} onChange={(hairc) => patch({ hairc })} />
                      <Color label="Outfit" value={recipe.c1} onChange={(c1) => patch({ c1 })} />
                      <Color label="Tie / trim" value={recipe.tie ?? [120, 130, 150]} onChange={(tie) => patch({ tie })} />
                      <Color label="Pants" value={recipe.pants ?? [54, 56, 70]} onChange={(pants) => patch({ pants })} />
                    </div>
                    <Row label="Outfit style"><Chips options={CLOTH_KINDS} value={recipe.cloth} onPick={(cloth) => patch({ cloth })} /></Row>
                    <Row label="Brows"><Chips options={BROW_KINDS} value={recipe.brow ?? 'flat'} onPick={(brow) => patch({ brow })} /></Row>
                    <Row label="Mouth"><Chips options={MOUTH_KINDS} value={recipe.mouth ?? 'neutral'} onPick={(mouth) => patch({ mouth })} /></Row>
                    <Row label="Facial hair">
                      <Chips options={['none', ...FACIAL_KINDS] as const} value={recipe.facial ?? 'none'} onPick={(f) => patch({ facial: f === 'none' ? undefined : f })} />
                    </Row>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                      {(['glasses', 'lashes', 'blush', 'heavy'] as const).map((k) => (
                        <label key={k} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13, color: 'var(--cth-ink-700)' }}>
                          <input type="checkbox" checked={!!recipe[k]} onChange={(e) => patch({ [k]: e.target.checked || undefined })} />
                          {k}
                        </label>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <Row label="Reference image (optional)">
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                          ref={fileRef}
                          type="file"
                          accept="image/png,image/jpeg,image/gif,image/webp"
                          hidden
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void loadImage(f, f.name); }}
                        />
                        <PixelButton size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>{image ? 'Change image…' : 'Image…'}</PixelButton>
                        {image ? (
                          <>
                            <img src={image.url} alt="reference" style={{ height: 48, imageRendering: 'pixelated', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }} />
                            <PixelButton size="sm" variant="ghost" onClick={() => { setImage(null); setSource(null); }}>Remove</PixelButton>
                          </>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>or paste one (⌘V / Ctrl+V). PNG, JPEG, GIF or WebP, up to 5 MB.</span>
                        )}
                      </div>
                    </Row>
                    {image && (
                      <>
                        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                          <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13, color: 'var(--cth-ink-700)' }}>
                            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> mirror left/right
                          </label>
                          <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13, color: 'var(--cth-ink-700)' }}>
                            <input type="checkbox" checked={fillFrame} onChange={(e) => setFillFrame(e.target.checked)} /> fill frame
                          </label>
                          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--cth-ink-700)' }}>
                            background
                            <input type="range" min={0} max={120} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
                          </label>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <PixelButton onClick={runPixelate} disabled={generating}>Pixelate</PixelButton>
                          <PixelButton variant="secondary" onClick={aiRedraw} disabled={generating}>{generating ? 'Drawing…' : 'AI redraw'}</PixelButton>
                          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                            Pixelate is instant and local. AI redraw has Claude redraw it cleaner, with a proper back view (about 1-2 minutes, on your Claude plan).
                          </span>
                        </div>
                      </>
                    )}
                    <Row label={image ? 'Optional note for the AI redraw' : 'Describe your character'}>
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="a red dragon mascot in a tiny tie"
                        rows={3}
                        style={{ ...inputStyle, resize: 'vertical' }}
                      />
                    </Row>
                    {!image && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <PixelButton onClick={generate} disabled={generating || !prompt.trim()}>{generating ? 'Drawing…' : ai ? 'Regenerate' : 'Generate'}</PixelButton>
                        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          Claude draws an 18×32 sprite (front + back) as SVG. Uses your normal Claude plan; takes about 1-2 minutes.
                        </span>
                      </div>
                    )}
                  </>
                )}

                {error && <div role="alert" style={{ fontSize: 13, color: 'var(--cth-coral, #c0392b)' }}>{error}</div>}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <PixelButton variant="ghost" onClick={doImport}>Import…</PixelButton>
                <PixelButton variant="ghost" onClick={doExport}>Export…</PixelButton>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <PixelButton variant="secondary" onClick={onClose}>Close</PixelButton>
                <PixelButton onClick={async () => { if (await doSave()) onClose(); }}>Save</PixelButton>
              </div>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function Chips<T extends string>({ options, value, onPick, label }: { options: readonly T[]; value: T; onPick: (v: T) => void; label?: (v: T) => string }) {
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onPick(o)}
          style={{
            padding: '3px 8px 1px', border: 'none', cursor: 'pointer',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
            background: value === o ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
            boxShadow: value === o ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)'
          }}
        >
          {label ? label(o) : o}
        </button>
      ))}
    </div>
  );
}

function Color({ label, value, onChange }: { label: string; value: [number, number, number]; onChange: (c: [number, number, number]) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-700)', textTransform: 'uppercase' }}>{label}</span>
      <input type="color" value={hex(value)} onChange={(e) => onChange(unhex(e.target.value))} style={{ width: 44, height: 28, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
    </label>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-700)', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)', fontSize: 16,
  color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};
