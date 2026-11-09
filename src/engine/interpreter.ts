/**
 * Content-stream interpreter. Tracks the graphics/text state exactly like a
 * PDF renderer would, and records every text-showing operator and XObject
 * placement with its byte range, font, matrices and colour.
 */
import { PDFArray, PDFDict, PDFName, PDFRef, type PDFDocument, type PDFObject, type PDFPage } from 'pdf-lib';
import { parseContent, type Operand, type Operation } from './lexer.ts';
import { FontCache, type PdfFont, type Glyph } from './fonts.ts';
import { dictGet, getDict, getName, resolve, streamBytes } from './pdfobj.ts';

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}
export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export interface FillColor {
  op: 'g' | 'rg' | 'k' | 'scn';
  cs?: string;
  comps: number[];
  pattern?: string;
}

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextRun {
  id: string;
  stream: number;
  opIndex: number;
  start: number;
  end: number;
  op: string;
  /** operands of the " operator */
  quoteArgs?: [number, number];
  fontKey: string;
  font: PdfFont;
  fs: number;
  Tc: number;
  Tw: number;
  Th: number;
  TL: number;
  Ts: number;
  Tr: number;
  ctm: Matrix;
  /** text matrix at the start of showing */
  tm: Matrix;
  glyphs: Glyph[];
  text: string;
  /** total x displacement in text space */
  advance: number;
  color: FillColor;
  /** fill opacity from the active ExtGState */
  alpha: number;
  /** text line matrix at the time of showing (to restore state after an in-stream redraw) */
  tlm: Matrix;
  /** id of the enclosing watermark artifact block, if any */
  wm?: string;
  /** clipping box in effect (user space), if any */
  clip?: BBox;
  /** show operands as strings/numbers, in order */
  items: (Uint8Array | number)[];
  units: RunUnit[];
  /** TJ numbers after the last unit */
  trailing: number[];
  bt: number;
  quad: [number, number][];
  bbox: BBox;
}

/** One editable unit of a run: a glyph (original bytes) or a kerning gap that reads as a space. */
export interface RunUnit {
  kind: 'glyph' | 'kern';
  text: string;
  /** original code bytes (glyph) */
  bytes: number[];
  code: number;
  /** advance width in 1/1000 em (glyph) */
  width: number;
  isSpace: boolean;
  /** TJ numbers that precede this unit inside the run */
  pre: number[];
  /** the TJ number itself (kern units) */
  tj: number;
}

export interface GroupUnit extends RunUnit {
  /** index of the run in the group; for gaps: the run before the gap */
  run: number;
  /** inter-run gap rendered as a space in the line text (not part of any operator) */
  gap?: boolean;
  /** user-space length of a gap */
  gapLen?: number;
}

export interface MarkedBlock {
  id: string;
  stream: number;
  startOp: number;
  endOp: number;
  start: number;
  end: number;
  /** marked-content tag + properties text, for display */
  label: string;
}

export interface WatermarkAnnot {
  id: string;
  ref: string;
  rect: BBox;
}

export interface XObjectRun {
  id: string;
  stream: number;
  opIndex: number;
  start: number;
  end: number;
  name: string;
  subtype: 'Image' | 'Form' | 'Inline';
  ctm: Matrix;
  alpha: number;
  /** enclosing watermark block id, or 'piece' for an Acrobat watermark form */
  wm?: string;
  quad: [number, number][];
  bbox: BBox;
}

export interface ContentStreamInfo {
  ref?: PDFRef;
  bytes: Uint8Array;
  ops: Operation[];
}

export interface PageModel {
  streams: ContentStreamInfo[];
  runs: TextRun[];
  xobjects: XObjectRun[];
  groups: TextGroup[];
  blocks: MarkedBlock[];
  annots: WatermarkAnnot[];
}

export interface TextGroup {
  id: string;
  runs: TextRun[];
  text: string;
  bbox: BBox;
  quad: [number, number][];
  /** rotation (radians) of the baseline in user space */
  angle: number;
  /** font size as seen in user space */
  visualSize: number;
  units: GroupUnit[];
}

interface GState {
  ctm: Matrix;
  fill: FillColor;
  fillCS: string;
  Tc: number;
  Tw: number;
  Th: number;
  TL: number;
  Ts: number;
  Tr: number;
  fontKey: string;
  font?: PdfFont;
  fs: number;
  alpha: number;
  clip?: BBox;
}

const num = (o: Operand | undefined) => (o && o.kind === 'num' ? o.value : 0);

function quadToBBox(q: [number, number][]): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of q) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

export function getContentStreams(doc: PDFDocument, page: PDFPage): ContentStreamInfo[] {
  const ctx = doc.context;
  const raw = page.node.get(PDFName.of('Contents'));
  const out: ContentStreamInfo[] = [];
  const add = (o: PDFObject | undefined) => {
    const bytes = streamBytes(ctx, o) ?? new Uint8Array();
    out.push({ ref: o instanceof PDFRef ? o : undefined, bytes, ops: [] });
  };
  const r = resolve(ctx, raw);
  if (r instanceof PDFArray) for (let i = 0; i < r.size(); i++) add(r.get(i));
  else if (r) add(raw);
  return out;
}

export function interpretPage(doc: PDFDocument, pageIndex: number, fonts: FontCache): PageModel {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const resources = page.node.Resources();
  const fontDict = getDict(ctx, resources, 'Font');
  const xobjDict = getDict(ctx, resources, 'XObject');
  const streams = getContentStreams(doc, page);
  const runs: TextRun[] = [];
  const xobjects: XObjectRun[] = [];

  let gs: GState = {
    ctm: IDENTITY, fill: { op: 'g', comps: [0] }, fillCS: 'DeviceGray',
    Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, Tr: 0, fontKey: '', fs: 0, alpha: 1,
  };
  const gsDict = getDict(ctx, resources, 'ExtGState');
  const propDict = getDict(ctx, resources, 'Properties');
  const blocks: MarkedBlock[] = [];
  const mcStack: { wm: boolean; s: number; i: number; start: number; label: string }[] = [];
  // current path bounds (user space) – used to know the clipping box
  let pathBox: BBox | undefined;
  let pendingClip = false;
  const addPt = (x: number, y: number) => {
    const [ux, uy] = apply(gs.ctm, x, y);
    if (!pathBox) pathBox = { x0: ux, y0: uy, x1: ux, y1: uy };
    else { pathBox.x0 = Math.min(pathBox.x0, ux); pathBox.y0 = Math.min(pathBox.y0, uy); pathBox.x1 = Math.max(pathBox.x1, ux); pathBox.y1 = Math.max(pathBox.y1, uy); }
  };
  const currentWm = () => {
    for (let k = mcStack.length - 1; k >= 0; k--) if (mcStack[k].wm) return `mc:${mcStack[k].s}:${mcStack[k].i}`;
    return undefined;
  };
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let bt = 0;
  const usedFonts = new Set<PdfFont>();

  const show = (s: number, i: number, op: Operation, items: Operand[], quoteArgs?: [number, number]) => {
    const font = gs.font;
    if (!font) return;
    usedFonts.add(font);
    const startTm = tm;
    const glyphs: Glyph[] = [];
    const rawItems: (Uint8Array | number)[] = [];
    const units: RunUnit[] = [];
    let pre: number[] = [];
    let adv = 0;
    let minX = Infinity, maxX = -Infinity;
    for (const it of items) {
      if (it.kind === 'num') {
        adv += (-it.value / 1000) * gs.fs * gs.Th;
        rawItems.push(it.value);
        const last = units[units.length - 1];
        // a big positive displacement between glyphs reads as a word space (TeX-style spacing)
        if (it.value < -180 && last && !/\s$/.test(last.text)) {
          units.push({ kind: 'kern', text: ' ', bytes: [], code: -1, width: 0, isSpace: false, pre, tj: it.value });
          pre = [];
        } else pre.push(it.value);
      } else if (it.kind === 'str') {
        rawItems.push(it.bytes);
        for (const g of font.decode(it.bytes)) {
          glyphs.push(g);
          units.push({ kind: 'glyph', text: g.unicode, bytes: g.bytes, code: g.code, width: g.width, isSpace: g.isSpace, pre, tj: 0 });
          pre = [];
          const gw = ((g.width / 1000) * gs.fs + gs.Tc + (g.isSpace ? gs.Tw : 0)) * gs.Th;
          // the box covers glyphs only (not kerning before/after them)
          minX = Math.min(minX, adv, adv + gw);
          maxX = Math.max(maxX, adv, adv + gw);
          adv += gw;
        }
      }
    }
    if (minX === Infinity) { minX = Math.min(0, adv); maxX = Math.max(0, adv); }
    tm = mul([1, 0, 0, 1, adv, 0], tm);
    const m = mul(startTm, gs.ctm);
    const top = gs.Ts + (font.ascent / 1000) * gs.fs;
    const bot = gs.Ts + (font.descent / 1000) * gs.fs;
    const quad: [number, number][] = [apply(m, minX, bot), apply(m, maxX, bot), apply(m, maxX, top), apply(m, minX, top)];
    runs.push({
      id: `${s}:${i}`, stream: s, opIndex: i, start: op.start, end: op.end, op: op.op, quoteArgs,
      fontKey: gs.fontKey, font, fs: gs.fs, Tc: gs.Tc, Tw: gs.Tw, Th: gs.Th, TL: gs.TL, Ts: gs.Ts, Tr: gs.Tr,
      ctm: gs.ctm, tm: startTm, glyphs, text: units.map((u) => u.text).join(''), advance: adv, items: rawItems, units, trailing: pre,
      color: { ...gs.fill, comps: gs.fill.comps.slice() }, alpha: gs.alpha, clip: gs.clip, tlm, wm: currentWm(), bt, quad, bbox: quadToBBox(quad),
    });
  };

  streams.forEach((st, s) => {
    st.ops = parseContent(st.bytes);
    st.ops.forEach((op, i) => {
      const a = op.operands;
      switch (op.op) {
        case 'q': stack.push({ ...gs }); break;
        case 'm': case 'l': addPt(num(a[0]), num(a[1])); break;
        case 'c': addPt(num(a[0]), num(a[1])); addPt(num(a[2]), num(a[3])); addPt(num(a[4]), num(a[5])); break;
        case 'v': case 'y': addPt(num(a[0]), num(a[1])); addPt(num(a[2]), num(a[3])); break;
        case 're': {
          const x = num(a[0]), y = num(a[1]), w = num(a[2]), hh = num(a[3]);
          addPt(x, y); addPt(x + w, y); addPt(x, y + hh); addPt(x + w, y + hh);
          break;
        }
        case 'W': case 'W*': pendingClip = true; break;
        case 'n': case 'f': case 'F': case 'f*': case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': {
          if (pendingClip && pathBox) {
            const c = gs.clip;
            gs.clip = c ? { x0: Math.max(c.x0, pathBox.x0), y0: Math.max(c.y0, pathBox.y0), x1: Math.min(c.x1, pathBox.x1), y1: Math.min(c.y1, pathBox.y1) } : { ...pathBox };
          }
          pendingClip = false;
          pathBox = undefined;
          break;
        }
        case 'Q': if (stack.length) gs = stack.pop()!; break;
        case 'cm': gs.ctm = mul([num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])], gs.ctm); break;
        case 'g': gs.fill = { op: 'g', comps: [num(a[0])] }; gs.fillCS = 'DeviceGray'; break;
        case 'rg': gs.fill = { op: 'rg', comps: [num(a[0]), num(a[1]), num(a[2])] }; gs.fillCS = 'DeviceRGB'; break;
        case 'k': gs.fill = { op: 'k', comps: [num(a[0]), num(a[1]), num(a[2]), num(a[3])] }; gs.fillCS = 'DeviceCMYK'; break;
        case 'cs': {
          const n = a[0]?.kind === 'name' ? a[0].value : 'DeviceGray';
          gs.fillCS = n;
          const comps = n === 'DeviceRGB' ? [0, 0, 0] : n === 'DeviceCMYK' ? [0, 0, 0, 1] : [0];
          gs.fill = { op: 'scn', cs: n, comps };
          break;
        }
        case 'sc': case 'scn': {
          const comps = a.filter((x) => x.kind === 'num').map((x) => (x as { value: number }).value);
          const pat = a.find((x) => x.kind === 'name') as { value: string } | undefined;
          gs.fill = { op: 'scn', cs: gs.fillCS, comps, pattern: pat?.value };
          break;
        }
        case 'BT': tm = IDENTITY; tlm = IDENTITY; bt++; break;
        case 'gs': {
          const nm = a[0]?.kind === 'name' ? a[0].value : '';
          const d = gsDict ? resolve(ctx, gsDict.get(PDFName.of(nm))) : undefined;
          if (d instanceof PDFDict) {
            const ca = resolve(ctx, d.get(PDFName.of('ca')));
            const n = (ca as { asNumber?: () => number } | undefined)?.asNumber?.();
            if (typeof n === 'number') gs.alpha = n;
          }
          break;
        }
        case 'BMC': mcStack.push({ wm: false, s, i, start: op.start, label: a[0]?.kind === 'name' ? a[0].value : '' }); break;
        case 'BDC': {
          const tag = a[0]?.kind === 'name' ? a[0].value : '';
          let sub = '', typ = '', label = tag;
          const p = a[1];
          if (p?.kind === 'dict') {
            const st = p.entries.Subtype, ty = p.entries.Type;
            if (st?.kind === 'name') sub = st.value;
            if (ty?.kind === 'name') typ = ty.value;
          } else if (p?.kind === 'name' && propDict) {
            const pd = resolve(ctx, propDict.get(PDFName.of(p.value)));
            if (pd instanceof PDFDict) { sub = getName(ctx, pd, 'Subtype') ?? ''; typ = getName(ctx, pd, 'Type') ?? ''; }
          }
          if (sub) label += ' ' + sub;
          void typ;
          mcStack.push({ wm: tag === 'Artifact' && sub === 'Watermark', s, i, start: op.start, label });
          break;
        }
        case 'EMC': {
          const b = mcStack.pop();
          if (b?.wm && b.s === s) blocks.push({ id: `mc:${b.s}:${b.i}`, stream: s, startOp: b.i, endOp: i, start: b.start, end: op.end, label: b.label });
          break;
        }
        case 'ET': break;
        case 'Tc': gs.Tc = num(a[0]); break;
        case 'Tw': gs.Tw = num(a[0]); break;
        case 'Tz': gs.Th = num(a[0]) / 100; break;
        case 'TL': gs.TL = num(a[0]); break;
        case 'Ts': gs.Ts = num(a[0]); break;
        case 'Tr': gs.Tr = num(a[0]); break;
        case 'Tf': {
          const key = a[0]?.kind === 'name' ? a[0].value : '';
          gs.fontKey = key;
          gs.fs = num(a[1]);
          gs.font = fontDict ? fonts.get(fontDict.get(PDFName.of(key))) : undefined;
          break;
        }
        case 'Td': tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], tlm); tm = tlm; break;
        case 'TD': gs.TL = -num(a[1]); tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], tlm); tm = tlm; break;
        case 'Tm': tlm = [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]; tm = tlm; break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.TL], tlm); tm = tlm; break;
        case 'Tj': show(s, i, op, a.slice(0, 1)); break;
        case 'TJ': show(s, i, op, a[0]?.kind === 'array' ? a[0].items : []); break;
        case "'":
          tlm = mul([1, 0, 0, 1, 0, -gs.TL], tlm); tm = tlm;
          show(s, i, op, a.slice(0, 1));
          break;
        case '"':
          gs.Tw = num(a[0]); gs.Tc = num(a[1]);
          tlm = mul([1, 0, 0, 1, 0, -gs.TL], tlm); tm = tlm;
          show(s, i, op, a.slice(2, 3), [num(a[0]), num(a[1])]);
          break;
        case 'Do': {
          const name = a[0]?.kind === 'name' ? a[0].value : '';
          const xo = xobjDict ? resolve(ctx, xobjDict.get(PDFName.of(name))) : undefined;
          const d = xo && 'dict' in xo ? (xo as unknown as { dict: PDFDict }).dict : undefined;
          const sub = d ? getName(ctx, d, 'Subtype') : undefined;
          if (sub === 'Image' || sub === 'Form') {
            let quad: [number, number][];
            if (sub === 'Image') quad = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
            else {
              const bb = dictGet(ctx, d, 'BBox');
              let r = [0, 0, 1, 1];
              if (bb instanceof PDFArray) r = bb.asArray().map((x) => Number((resolve(ctx, x) as { asNumber?: () => number })?.asNumber?.() ?? 0));
              const fm = dictGet(ctx, d, 'Matrix');
              let m: Matrix = IDENTITY;
              if (fm instanceof PDFArray) m = fm.asArray().map((x) => Number((resolve(ctx, x) as { asNumber?: () => number })?.asNumber?.() ?? 0)) as Matrix;
              const mm = mul(m, gs.ctm);
              quad = [apply(mm, r[0], r[1]), apply(mm, r[2], r[1]), apply(mm, r[2], r[3]), apply(mm, r[0], r[3])];
            }
            const piece = sub === 'Form' && d && dictGet(ctx, d, 'PieceInfo') ? String(dictGet(ctx, d, 'PieceInfo')).includes('Watermark') : false;
            xobjects.push({ id: `${s}:${i}`, stream: s, opIndex: i, start: op.start, end: op.end, name, subtype: sub, ctm: gs.ctm, alpha: gs.alpha, wm: currentWm() ?? (piece ? 'piece' : undefined), quad, bbox: quadToBBox(quad) });
          }
          break;
        }
        case 'BI': {
          const quad: [number, number][] = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
          xobjects.push({ id: `${s}:${i}`, stream: s, opIndex: i, start: op.start, end: op.end, name: '', subtype: 'Inline', ctm: gs.ctm, alpha: gs.alpha, wm: currentWm(), quad, bbox: quadToBBox(quad) });
          break;
        }
      }
    });
  });
  for (const f of usedFonts) f.touch();
  // watermark annotations
  const annots: WatermarkAnnot[] = [];
  const an = page.node.Annots();
  if (an) for (let k = 0; k < an.size(); k++) {
    const raw = an.get(k);
    const ad = resolve(ctx, raw);
    if (ad instanceof PDFDict && getName(ctx, ad, 'Subtype') === 'Watermark') {
      const r = (dictGet(ctx, ad, 'Rect') as PDFArray | undefined)?.asArray().map((x) => (resolve(ctx, x) as { asNumber?: () => number })?.asNumber?.() ?? 0) ?? [0, 0, 0, 0];
      const ref = raw instanceof PDFRef ? `${raw.objectNumber}_${raw.generationNumber}` : `d${k}`;
      annots.push({ id: `annot:${ref}`, ref, rect: { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) } });
    }
  }
  return { streams, runs, xobjects, groups: groupRuns(runs), blocks, annots };
}

/**
 * Merge consecutive runs that sit on the same baseline with the same font into
 * editable "line" groups – PDFs often split a visual line into many operators.
 */
export function groupRuns(runs: TextRun[]): TextGroup[] {
  const groups: TextGroup[] = [];
  let cur: { runs: TextRun[]; units: GroupUnit[]; inv: Matrix; endX: number; base: TextRun; dir: number } | undefined;
  const close = () => {
    if (!cur) return;
    const quad = groupQuad(cur.runs);
    const m = mul(cur.base.tm, cur.base.ctm);
    const angle = Math.atan2(m[1], m[0]);
    const visualSize = Math.abs(cur.base.fs) * Math.hypot(m[2], m[3]);
    const text = cur.units.map((u) => u.text).join('');
    groups.push({ id: cur.runs[0].id, runs: cur.runs, text, bbox: quadToBBox(quad), quad, angle, visualSize, units: cur.units });
    cur = undefined;
  };
  const unitsOf = (r: TextRun, idx: number): GroupUnit[] => r.units.map((u) => ({ ...u, run: idx }));
  for (const r of runs) {
    if (r.glyphs.length === 0) continue;
    const m = mul(r.tm, r.ctm);
    const dir = Math.atan2(m[1], m[0]);
    if (cur) {
      const b = cur.base;
      // a line may mix fonts, sizes and colours (bold words, currency symbols from another font…);
      // every run keeps its own font/colour when edited
      const compatible = (r.Tr === 3) === (b.Tr === 3) && r.wm === b.wm && Math.abs(dir - cur.dir) < 0.02;
      if (compatible) {
        const p = apply(cur.inv, m[4], m[5]);
        const fs = Math.abs(b.fs) || 1;
        const gap = p[0] - cur.endX;
        // run size expressed in the base frame
        const rs = (Math.abs(r.fs) * Math.hypot(m[2], m[3])) / (Math.abs(b.fs) * Math.hypot(...(mul(b.tm, b.ctm).slice(2, 4) as [number, number])) || 1) * fs;
        const lim = Math.max(fs, rs);
        if (Math.abs(p[1]) < 0.35 * lim && gap > -0.3 * lim && gap < 0.9 * lim) {
          const lastText = cur.units.length ? cur.units[cur.units.length - 1].text : '';
          const needSpace = gap > 0.18 * lim && !/\s$/.test(lastText) && !/^\s/.test(r.text);
          if (needSpace) {
            const bm = mul(b.tm, b.ctm);
            cur.units.push({ kind: 'kern', text: ' ', bytes: [], code: -1, width: 0, isSpace: false, pre: [], tj: 0, run: cur.runs.length - 1, gap: true, gapLen: gap * Math.hypot(bm[0], bm[1]) });
          }
          cur.units.push(...unitsOf(r, cur.runs.length));
          cur.runs.push(r);
          const pe = apply(cur.inv, ...apply(m, r.advance, 0));
          cur.endX = pe[0];
          continue;
        }
      }
      close();
    }
    cur = { runs: [r], units: unitsOf(r, 0), inv: invert(m), endX: r.advance, base: r, dir };
  }
  close();
  return groups;
}

function sameColor(a: FillColor, b: FillColor): boolean {
  return a.op === b.op && a.cs === b.cs && a.pattern === b.pattern && a.comps.length === b.comps.length && a.comps.every((v, i) => Math.abs(v - b.comps[i]) < 1e-6);
}

function sameFamily(a: PdfFont, b: PdfFont): boolean {
  return a === b || (a.displayName === b.displayName && a.subtype === b.subtype);
}

function groupQuad(runs: TextRun[]): [number, number][] {
  const b = runs[0];
  const m = mul(b.tm, b.ctm);
  const inv = invert(m);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of runs) for (const pt of r.quad) {
    const [x, y] = apply(inv, pt[0], pt[1]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return [apply(m, minX, minY), apply(m, maxX, minY), apply(m, maxX, maxY), apply(m, minX, maxY)];
}
