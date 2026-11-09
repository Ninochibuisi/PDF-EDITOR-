/**
 * Smart scan: document-wide analysis that finds watermarks (tagged artifacts,
 * Acrobat watermark objects, watermark annotations and heuristic look-alikes),
 * scanned pages and other structure, so they can be edited or removed.
 */
import { mul } from './interpreter.ts';
import type { BBox, FillColor, PageModel, TextGroup } from './interpreter.ts';
import type { RGB } from './model.ts';

export interface PageInfo {
  key: string;
  /** 1-based position in the document */
  number: number;
  model: PageModel;
  /** crop box [x, y, w, h] */
  box: [number, number, number, number];
}

export interface WatermarkHit {
  key: string;
  /** removal targets understood by the engine */
  targets: string[];
  /** text groups that make up the watermark on this page (editable in place) */
  groupIds: string[];
  bbox: BBox;
}

export interface DetectedWatermark {
  id: string;
  kind: 'artifact' | 'acrobat' | 'annotation' | 'text' | 'image';
  confidence: 'certain' | 'likely';
  label: string;
  reason: string;
  hits: WatermarkHit[];
  /** properties of the first occurrence (for "edit" / "recreate") */
  sample?: { text: string; size: number; angle: number; color: RGB; opacity: number; font: string };
}

export interface ScanReport {
  pages: number;
  textLines: number;
  images: number;
  fonts: number;
  scannedPages: number[];
  invisibleTextPages: number[];
  watermarks: DetectedWatermark[];
}

const KEYWORDS = /confidential|draft|sample|copy|watermark|do not|internal|approved|void|paid|preview|specimen|proprietary|restricted|secret|not for|evaluation|trial|unofficial/i;

export function fillRgb(c: FillColor): RGB {
  const v = c.comps;
  if (v.length === 1) return [v[0], v[0], v[0]];
  if (v.length === 3) return [v[0], v[1], v[2]];
  if (v.length === 4) return [(1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])];
  return [0, 0, 0];
}

function groupAngle(g: TextGroup): number {
  let a = (g.angle * 180) / Math.PI;
  a = ((a % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

function sampleOf(g: TextGroup) {
  const r = g.runs[0];
  return { text: g.text.trim(), size: Math.round(g.visualSize), angle: Math.round(groupAngle(g)), color: fillRgb(r.color), opacity: r.alpha, font: r.font.displayName };
}

const bboxUnion = (a: BBox, b: BBox): BBox => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();

export function scanDocument(pages: PageInfo[]): ScanReport {
  const out: DetectedWatermark[] = [];
  const byLabel = new Map<string, DetectedWatermark>();
  const add = (kind: DetectedWatermark['kind'], label: string, reason: string, hit: WatermarkHit, sample?: DetectedWatermark['sample'], confidence: DetectedWatermark['confidence'] = 'certain') => {
    const k = kind + '|' + norm(label);
    let d = byLabel.get(k);
    if (!d) {
      d = { id: 'wm' + out.length, kind, confidence, label, reason, hits: [], sample };
      byLabel.set(k, d);
      out.push(d);
    }
    const prev = d.hits.find((h) => h.key === hit.key);
    if (prev) {
      prev.targets.push(...hit.targets.filter((t) => !prev.targets.includes(t)));
      prev.groupIds.push(...hit.groupIds);
      prev.bbox = bboxUnion(prev.bbox, hit.bbox);
    } else d.hits.push(hit);
  };

  let textLines = 0, images = 0;
  const fonts = new Set<string>();
  const scannedPages: number[] = [];
  const invisibleTextPages: number[] = [];

  // ---- 1. certain: tagged artifacts, Acrobat watermark forms, watermark annotations
  for (const p of pages) {
    const m = p.model;
    textLines += m.groups.length;
    images += m.xobjects.filter((x) => x.subtype !== 'Form').length;
    for (const g of m.groups) fonts.add(g.runs[0].font.baseFont);
    for (const b of m.blocks) {
      const groups = m.groups.filter((g) => g.runs[0].wm === b.id);
      const xos = m.xobjects.filter((x) => x.wm === b.id);
      const text = groups.map((g) => g.text.trim()).filter(Boolean).join(' ');
      let bbox: BBox | undefined;
      for (const g of groups) bbox = bbox ? bboxUnion(bbox, g.bbox) : g.bbox;
      for (const x of xos) bbox = bbox ? bboxUnion(bbox, x.bbox) : x.bbox;
      add('artifact', text || (xos.length ? 'Graphic watermark' : 'Watermark'), 'Tagged as a watermark artifact in the PDF', {
        key: p.key, targets: [b.id], groupIds: groups.map((g) => g.id), bbox: bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
      }, groups[0] ? sampleOf(groups[0]) : undefined);
    }
    for (const x of m.xobjects.filter((x) => x.wm === 'piece')) {
      add('acrobat', 'Acrobat watermark', 'Watermark object created by Adobe Acrobat', { key: p.key, targets: [`xo:${x.id}`], groupIds: [], bbox: x.bbox });
    }
    for (const a of m.annots) {
      add('annotation', 'Watermark annotation', 'Annotation of type /Watermark', { key: p.key, targets: [a.id], groupIds: [], bbox: a.rect });
    }
    // scanned page: no visible text, one image covering most of the page
    const [, , w, h] = p.box;
    const big = m.xobjects.some((x) => x.subtype !== 'Form' && (x.bbox.x1 - x.bbox.x0) * (x.bbox.y1 - x.bbox.y0) > 0.6 * w * h);
    const visible = m.groups.filter((g) => g.runs[0].Tr !== 3 && g.runs[0].Tr !== 7);
    if (big && visible.length === 0) scannedPages.push(p.number);
    if (m.groups.some((g) => g.runs[0].Tr === 3)) invisibleTextPages.push(p.number);
  }

  // ---- 2. heuristic text watermarks (untagged)
  type Cand = { p: PageInfo; g: TextGroup; score: number; why: string[] };
  const cands: Cand[] = [];
  for (const p of pages) {
    const [, , w, h] = p.box;
    for (const g of p.model.groups) {
      const r = g.runs[0];
      if (r.wm || r.Tr === 3) continue;
      const t = g.text.trim();
      if (t.length < 2) continue;
      const why: string[] = [];
      let score = 0;
      const ang = Math.abs(groupAngle(g));
      if (ang > 8 && ang < 172 && Math.abs(ang - 90) > 3) { score += 2; why.push('diagonal'); }
      if (r.alpha < 0.98) { score += 2; why.push('semi-transparent'); }
      if (g.visualSize >= 28) { score += 1; why.push('very large'); }
      const [cr, cg, cb] = fillRgb(r.color);
      const luma = 0.299 * cr + 0.587 * cg + 0.114 * cb;
      if (luma > 0.55 && luma < 0.97) { score += 1; why.push('light colour'); }
      if (KEYWORDS.test(t) && t.length < 60) { score += 2; why.push('watermark wording'); }
      const cx = (g.bbox.x0 + g.bbox.x1) / 2, cy = (g.bbox.y0 + g.bbox.y1) / 2;
      if (Math.abs(cx - (p.box[0] + w / 2)) < w * 0.2 && Math.abs(cy - (p.box[1] + h / 2)) < h * 0.2 && g.visualSize >= 20) { score += 1; why.push('centred'); }
      if (score >= 2) cands.push({ p, g, score, why });
    }
  }
  // cluster by text; repetition across pages at the same spot is a strong signal
  const clusters = new Map<string, Cand[]>();
  for (const c of cands) {
    const k = norm(c.g.text);
    (clusters.get(k) ?? clusters.set(k, []).get(k)!).push(c);
  }
  for (const [, cs] of clusters) {
    const pagesHit = new Set(cs.map((c) => c.p.key));
    const repeated = pagesHit.size >= 2 && pagesHit.size >= Math.min(3, pages.length);
    const best = cs.reduce((a, b) => (b.score > a.score ? b : a));
    const score = best.score + (repeated ? 2 : 0);
    if (score < 4) continue;
    const why = [...new Set(cs.flatMap((c) => c.why))];
    if (repeated) why.push(`repeated on ${pagesHit.size} pages`);
    for (const c of cs) {
      add('text', c.g.text.trim(), why.join(', '), { key: c.p.key, targets: [`group:${c.g.id}`], groupIds: [c.g.id], bbox: c.g.bbox }, sampleOf(best.g), score >= 6 ? 'certain' : 'likely');
    }
  }

  // ---- 3. heuristic image watermarks: translucent large images, or the same image in the same spot on most pages
  const imgSeen = new Map<string, { p: PageInfo; id: string; bbox: BBox; alpha: number }[]>();
  for (const p of pages) {
    const [, , w, h] = p.box;
    for (const x of p.model.xobjects) {
      if (x.wm || x.subtype === 'Inline') continue;
      const area = (x.bbox.x1 - x.bbox.x0) * (x.bbox.y1 - x.bbox.y0);
      if (area < 0.04 * w * h || area > 0.97 * w * h) continue;
      const k = `${x.name}|${Math.round(x.bbox.x0 / 4)}|${Math.round(x.bbox.y0 / 4)}|${Math.round(area / 100)}`;
      (imgSeen.get(k) ?? imgSeen.set(k, []).get(k)!).push({ p, id: x.id, bbox: x.bbox, alpha: x.alpha });
    }
  }
  for (const [k, list] of imgSeen) {
    const translucent = list.some((l) => l.alpha < 0.98);
    const repeated = list.length >= 3 && list.length >= pages.length * 0.6;
    if (!translucent && !repeated) continue;
    const label = translucent ? 'Translucent image' : 'Repeated image';
    for (const l of list) add('image', label + ' ' + k.split('|')[0], translucent ? 'semi-transparent image' : `same image at the same position on ${list.length} pages`, { key: l.p.key, targets: [`xo:${l.id}`], groupIds: [], bbox: l.bbox }, undefined, translucent ? 'likely' : 'likely');
  }

  // label tidy-up
  for (const d of out) if (d.kind === 'image') d.label = d.label.replace(/ \S+$/, '');
  return { pages: pages.length, textLines, images, fonts: fonts.size, scannedPages, invisibleTextPages, watermarks: out };
}

void mul;
