import { useEffect, useRef } from 'react';
import { paintCastPortrait, type CharacterId } from '@/scene/office/cast';
import { PORTRAIT_W, PORTRAIT_H } from '@/scene/office/portraitArt';
import { useCustomCharacters } from '@/scene/office/customCharacters';

const FRAME_W = PORTRAIT_W;
const FRAME_H = PORTRAIT_H;

export interface SpritePortraitProps {
  character: CharacterId;
  /** Pixels per source pixel. Whole numbers are exact; half-steps (1.5, 2.5)
   *  double every other row, which pixel art survives. The blit runs with
   *  smoothing off, so nothing here is ever interpolated. */
  scale?: number;
  background?: string;
}

/** Static standing portrait of an Office cast member (recolored LimeZu sprite). */
export function SpritePortrait({
  character,
  scale = 2,
  background = 'transparent'
}: SpritePortraitProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Custom art is edited in place under a stable id, so repaint when it changes.
  const rev = useCustomCharacters((s) => s.rev);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let cancelled = false;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    paintCastPortrait(ctx, character, scale).catch(() => { /* asset load race */ });
    return () => { cancelled = true; void cancelled; };
  }, [character, scale, background, rev]);

  // A fractional scale can land on a fractional pixel count; the canvas
  // attributes are integers either way, so round once and use the same number
  // for the backing store and the CSS box (a mismatch is what makes pixel art
  // blurry).
  const w = Math.round(FRAME_W * scale);
  const h = Math.round(FRAME_H * scale);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      style={{
        width: w,
        height: h,
        imageRendering: 'pixelated'
      }}
    />
  );
}
