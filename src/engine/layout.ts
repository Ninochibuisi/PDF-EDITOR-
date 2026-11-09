/**
 * Line layout helpers: detects how a line was aligned in the original
 * document so edits keep that alignment (a centred title stays centred, a
 * right-aligned date stays flush right), plus geometry used for snapping.
 */
import type { BBox, TextGroup } from './interpreter.ts';

export type Align = 'left' | 'center' | 'right';

export interface Alignment {
  align: Align;
  reason: string;
}

const horizontal = (g: TextGroup) => Math.abs(Math.sin(g.angle)) < 0.02 && Math.cos(g.angle) > 0;

/** visual extent of a line without trailing/leading blanks */
export function lineExtent(g: TextGroup): { x0: number; x1: number; cx: number } {
  const x0 = g.bbox.x0, x1 = g.bbox.x1;
  return { x0, x1, cx: (x0 + x1) / 2 };
}

export function detectAlignment(g: TextGroup, all: TextGroup[], page: { x: number; w: number }): Alignment {
  if (!horizontal(g)) return { align: 'left', reason: 'rotated line' };
  const me = lineExtent(g);
  const w = me.x1 - me.x0;
  const tol = Math.max(1.2, g.visualSize * 0.08);
  const others = all.filter((o) => o !== g && horizontal(o) && o.text.trim().length > 1 && o.bbox.x1 - o.bbox.x0 > 8);
  const sharesLeft = others.filter((o) => Math.abs(o.bbox.x0 - me.x0) < tol && Math.abs((o.bbox.x0 + o.bbox.x1) / 2 - me.cx) > 3 * tol);
  const sharesCenter = others.filter((o) => Math.abs((o.bbox.x0 + o.bbox.x1) / 2 - me.cx) < tol && Math.abs(o.bbox.x0 - me.x0) > 3 * tol);
  const sharesRight = others.filter((o) => Math.abs(o.bbox.x1 - me.x1) < tol && Math.abs(o.bbox.x0 - me.x0) > 3 * tol);
  const pageCx = page.x + page.w / 2;
  const onPageCenter = Math.abs(me.cx - pageCx) < Math.max(2.5, page.w * 0.012) && w < page.w * 0.9;
  const clip = g.runs[0].clip;
  const clipCentered = clip && clip.x1 - clip.x0 > w + 4 && Math.abs((clip.x0 + clip.x1) / 2 - me.cx) < tol;
  const clipRight = clip && clip.x1 - clip.x0 > w + 4 && Math.abs(clip.x1 - me.x1) < tol && me.x0 - clip.x0 > 4;

  // left-aligned with other lines wins unless the centring evidence is stronger
  if (sharesLeft.length >= 2 && sharesCenter.length === 0) return { align: 'left', reason: `shares its left edge with ${sharesLeft.length} lines` };
  if (sharesCenter.length && sharesCenter.length >= sharesLeft.length) return { align: 'center', reason: `centred with ${sharesCenter.length} other line${sharesCenter.length > 1 ? 's' : ''}` };
  if (clipCentered) return { align: 'center', reason: 'centred in its box' };
  if (onPageCenter && sharesLeft.length === 0) return { align: 'center', reason: 'centred on the page' };
  if ((sharesRight.length && sharesRight.length > sharesLeft.length) || clipRight) return { align: 'right', reason: clipRight ? 'right-aligned in its box' : 'shares its right edge with other lines' };
  return { align: 'left', reason: sharesLeft.length ? `shares its left edge with ${sharesLeft.length} line${sharesLeft.length > 1 ? 's' : ''}` : 'default' };
}

/** x positions other content is aligned to (for snapping guides) */
export function snapTargets(groups: TextGroup[], exclude: TextGroup | undefined, page: { x: number; w: number }): { x: number; kind: 'page' | 'edge' | 'center' }[] {
  const out: { x: number; kind: 'page' | 'edge' | 'center' }[] = [{ x: page.x + page.w / 2, kind: 'page' }];
  for (const g of groups) {
    if (g === exclude || !horizontal(g)) continue;
    const e = lineExtent(g);
    out.push({ x: e.x0, kind: 'edge' }, { x: e.x1, kind: 'edge' }, { x: e.cx, kind: 'center' });
  }
  return out;
}

export function bboxCenter(b: BBox) {
  return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
}
