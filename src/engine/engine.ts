/**
 * The editing engine.
 *
 *  - Sources are parsed once for analysis (text runs, fonts, images).
 *  - Every build starts from the pristine source bytes and applies the
 *    declarative EditorState, so the preview is exactly what gets exported.
 *  - Text is edited *inside the content stream*, re-encoded with the original
 *    embedded font. Untouched bytes are left exactly as they were.
 */
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFButton,
  PDFSignature,
  StandardFonts,
  degrees,
  type PDFFont as LibFont,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Encodings } from '@pdf-lib/standard-fonts';
import { FontCache, standardFontFor, encodeMulti, type MultiEncode, type PdfFont } from './fonts.ts';
import { interpretPage, mul, apply, invert, type Matrix, type PageModel, type TextGroup, type TextRun, type XObjectRun, type FillColor } from './interpreter.ts';
import { fmtNum, hexString, latin1, nameToken, type Operand } from './lexer.ts';
import type { Asset, EditorState, Overlay, RGB, TextEdit } from './model.ts';
import { resolve } from './pdfobj.ts';

export interface SourceInfo {
  id: string;
  name: string;
  bytes: Uint8Array;
}

export class SourceDoc {
  doc!: PDFDocument;
  fonts!: FontCache;
  models = new Map<number, PageModel>();
  pageCount = 0;
  encrypted = false;
  info: SourceInfo;
  constructor(info: SourceInfo) {
    this.info = info;
  }
  static async open(info: SourceInfo): Promise<SourceDoc> {
    const s = new SourceDoc(info);
    s.doc = await PDFDocument.load(info.bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    s.encrypted = s.doc.isEncrypted;
    s.fonts = new FontCache(s.doc.context);
    s.pageCount = s.doc.getPageCount();
    return s;
  }
  model(i: number): PageModel {
    let m = this.models.get(i);
    if (!m) {
      try {
        m = interpretPage(this.doc, i, this.fonts);
      } catch (e) {
        console.warn('interpret failed', e);
        m = { streams: [], runs: [], xobjects: [], groups: [] };
      }
      this.models.set(i, m);
    }
    return m;
  }
  pageSize(i: number): { w: number; h: number; rotate: number; box: [number, number, number, number] } {
    const p = this.doc.getPage(i);
    const b = p.getCropBox();
    return { w: b.width, h: b.height, rotate: p.getRotation().angle, box: [b.x, b.y, b.width, b.height] };
  }
}

export const STANDARD_FONT_NAMES = Object.values(StandardFonts) as string[];

// ---------------------------------------------------------------------------
// Encoding analysis used by the UI
// ---------------------------------------------------------------------------
export interface EditPlan {
  mode: 'inplace' | 'reemit-original' | 'substitute' | 'delete';
  missing: string[];
  substituteFont?: string;
}

export function planTextEdit(group: TextGroup, edit: TextEdit): EditPlan {
  if (edit.deleted) return { mode: 'delete', missing: [] };
  const base = group.runs[0];
  const text = edit.text ?? group.text;
  const enc = encodeGroup(group, text);
  const restyle = !!(edit.dx || edit.dy || (edit.scale && edit.scale !== 1) || edit.color);
  if (!enc.ok || edit.forceFallback)
    return { mode: 'substitute', missing: enc.missing, substituteFont: edit.fallbackFont ?? standardFontFor(base.font.baseFont, base.font) };
  return { mode: restyle ? 'reemit-original' : 'inplace', missing: [] };
}

/** Distinct fonts of a group (base first) with the resource key that selects each. */
export function groupFonts(group: TextGroup): { font: PdfFont; key: string }[] {
  const out: { font: PdfFont; key: string }[] = [];
  for (const r of group.runs) if (!out.some((f) => f.font === r.font)) out.push({ font: r.font, key: r.fontKey });
  return out;
}

export function encodeGroup(group: TextGroup, text: string): MultiEncode {
  return encodeMulti(groupFonts(group).map((f) => f.font), text);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const enc = new TextEncoder();

interface StreamPatch {
  start: number;
  end: number;
  text: string;
}

function tjOperand(items: (Uint8Array | number)[]): string {
  return '[' + items.map((it) => (typeof it === 'number' ? fmtNum(it) : hexString(it))).join(' ') + ']';
}

function opPrefix(run: TextRun): string {
  if (run.op === "'") return 'T* ';
  if (run.op === '"' && run.quoteArgs) return `${fmtNum(run.quoteArgs[0])} Tw ${fmtNum(run.quoteArgs[1])} Tc T* `;
  return '';
}

/** TJ value that moves the pen by `adv` text-space units. */
function kernFor(run: TextRun, adv: number): number {
  const d = run.fs * run.Th;
  return d ? (-adv * 1000) / d : 0;
}

function hideRun(run: TextRun): string {
  const k = kernFor(run, run.advance);
  return opPrefix(run) + (Math.abs(k) > 1e-6 ? `[${fmtNum(k)}] TJ` : '[] TJ');
}

function encodedAdvance(run: TextRun, e: MultiEncode): number {
  let adv = 0;
  for (const sg of e.segs)
    for (const g of sg.glyphs) {
      if (g.code < 0) adv += (g.width / 1000) * run.fs * run.Th;
      else adv += ((g.width / 1000) * run.fs + run.Tc + (g.isSpace ? run.Tw : 0)) * run.Th;
    }
  return adv;
}

/** Show operators for encoded segments, switching fonts as needed. Starts in font `startFi` (-1: none set). */
function showSegments(group: TextGroup, e: MultiEncode, fs: number, startFi: number, lead = 0, tail = 0): string {
  const fonts = groupFonts(group);
  let cur = startFi;
  let s = '';
  if (Math.abs(lead) > 1e-4) {
    if (cur < 0) { s += `${nameToken(fonts[0].key)} ${fmtNum(fs)} Tf `; cur = 0; }
    s += `[${fmtNum(lead)}] TJ `;
  }
  for (const sg of e.segs) {
    if (sg.fi !== cur) {
      s += `${nameToken(fonts[sg.fi].key)} ${fmtNum(fs)} Tf `;
      cur = sg.fi;
    }
    s += tjOperand(sg.items) + ' TJ ';
  }
  if (Math.abs(tail) > 1e-4) {
    if (cur < 0) { s += `${nameToken(fonts[0].key)} ${fmtNum(fs)} Tf `; cur = 0; }
    s += `[${fmtNum(tail)}] TJ `;
  }
  if (startFi >= 0 && cur !== startFi) s += `${nameToken(fonts[startFi].key)} ${fmtNum(fs)} Tf `;
  return s.trim() || '[] TJ';
}

function colorOps(c: FillColor): string {
  const comps = c.comps.map(fmtNum).join(' ');
  if (c.op === 'g' || c.op === 'rg' || c.op === 'k') return `${comps} ${c.op}`;
  const cs = c.cs ?? 'DeviceGray';
  const csTok = /^Device(Gray|RGB|CMYK)$/.test(cs) || cs === 'Pattern' ? '/' + cs : nameToken(cs);
  return `${csTok} cs ${comps}${c.pattern ? ' ' + nameToken(c.pattern) : ''} scn`;
}

const rgbOps = (c: RGB, stroke = false) => `${c.map((v) => fmtNum(v)).join(' ')} ${stroke ? 'RG' : 'rg'}`;
const mat = (m: Matrix) => m.map(fmtNum).join(' ');

/** The show-string items (strings + kerning numbers) of a run's operator. */
function runItems(run: TextRun, operands: Operand[]): (Uint8Array | number)[] {
  const items: Operand[] =
    run.op === 'TJ' ? (operands[0]?.kind === 'array' ? operands[0].items : []) : run.op === '"' ? operands.slice(2, 3) : operands.slice(0, 1);
  const out: (Uint8Array | number)[] = [];
  for (const it of items) {
    if (it.kind === 'num') out.push(it.value);
    else if (it.kind === 'str') out.push(it.bytes);
  }
  return out;
}

/** Rewrite a run keeping only glyphs for which keep() is true (glyph-level redaction). */
function rewriteRunKeeping(run: TextRun, operands: Operand[], keep: (x0: number, x1: number) => boolean): string {
  const items: Operand[] =
    run.op === 'TJ' ? (operands[0]?.kind === 'array' ? operands[0].items : []) : run.op === '"' ? operands.slice(2, 3) : operands.slice(0, 1);
  const out: (Uint8Array | number)[] = [];
  let x = 0;
  let pendingKern = 0;
  let cur: number[] = [];
  const flush = () => {
    if (cur.length) out.push(Uint8Array.from(cur));
    cur = [];
  };
  for (const it of items) {
    if (it.kind === 'num') {
      flush();
      pendingKern += it.value;
      x += (-it.value / 1000) * run.fs * run.Th;
      continue;
    }
    if (it.kind !== 'str') continue;
    for (const g of run.font.decode(it.bytes)) {
      const adv = ((g.width / 1000) * run.fs + run.Tc + (g.isSpace ? run.Tw : 0)) * run.Th;
      if (keep(x, x + adv)) {
        if (pendingKern) {
          flush();
          out.push(pendingKern);
          pendingKern = 0;
        }
        cur.push(...g.bytes);
      } else {
        flush();
        pendingKern += kernFor(run, adv);
      }
      x += adv;
    }
  }
  flush();
  if (pendingKern) out.push(pendingKern);
  return opPrefix(run) + tjOperand(out) + ' TJ';
}

interface BuildCtx {
  doc: PDFDocument;
  stdFonts: Map<string, LibFont>;
  customFonts: Map<string, LibFont>;
  assets: Map<string, Asset>;
  images: Map<string, PDFRef>;
}

async function getLibFont(bc: BuildCtx, name: string): Promise<LibFont> {
  if (name.startsWith('asset:')) {
    const id = name.slice(6);
    let f = bc.customFonts.get(id);
    if (!f) {
      const a = bc.assets.get(id);
      if (!a) return getLibFont(bc, StandardFonts.Helvetica);
      try {
        f = await bc.doc.embedFont(a.bytes, { subset: false });
      } catch (e) {
        console.warn('custom font failed, using Helvetica', e);
        return getLibFont(bc, StandardFonts.Helvetica);
      }
      bc.customFonts.set(id, f);
    }
    return f;
  }
  if (!STANDARD_FONT_NAMES.includes(name)) name = StandardFonts.Helvetica;
  let f = bc.stdFonts.get(name);
  if (!f) {
    f = await bc.doc.embedFont(name as StandardFonts);
    bc.stdFonts.set(name, f);
  }
  return f;
}

async function getImageName(bc: BuildCtx, page: PDFPage, assetId: string): Promise<string | undefined> {
  let ref = bc.images.get(assetId);
  if (!ref) {
    const a = bc.assets.get(assetId);
    if (!a) return undefined;
    const img = a.kind === 'png' ? await bc.doc.embedPng(a.bytes) : await bc.doc.embedJpg(a.bytes);
    await img.embed();
    ref = img.ref;
    bc.images.set(assetId, ref);
  }
  return page.node.newXObject('EdIm', ref).decodeText();
}

/** Replace characters a pdf-lib font cannot show. */
function libClean(font: LibFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return Array.from(text).map((c) => (set.has(c.codePointAt(0)!) ? c : '?')).join('');
}
/** Characters a standard font cannot show (WinAnsi). */
export function unsupportedStandardChars(text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch !== '\n' && !Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) out.add(ch);
  }
  return [...out];
}
/** Encode text for a pdf-lib font. */
function libEncode(font: LibFont, text: string): string {
  return font.encodeText(libClean(font, text)).toString();
}

/** Replace the page's content with patched streams + an appended stream. */
function writePageContent(doc: PDFDocument, page: PDFPage, model: PageModel, patches: Map<number, StreamPatch[]>, append: string) {
  const ctx = doc.context;
  const refs: PDFRef[] = [];
  model.streams.forEach((st, i) => {
    const ps = patches.get(i);
    if (!ps || !ps.length) {
      if (st.ref) refs.push(st.ref);
      else refs.push(ctx.register(ctx.flateStream(st.bytes)));
      return;
    }
    ps.sort((a, b) => a.start - b.start);
    const parts: Uint8Array[] = [];
    let pos = 0;
    for (const p of ps) {
      if (p.start < pos) continue; // overlapping patch – skip
      parts.push(st.bytes.subarray(pos, p.start));
      parts.push(latin1(' ' + p.text + ' '));
      pos = p.end;
    }
    parts.push(st.bytes.subarray(pos));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    refs.push(ctx.register(ctx.flateStream(out)));
  });
  if (append) {
    const pre = ctx.register(ctx.flateStream(enc.encode('q\n')));
    const post = ctx.register(ctx.flateStream(enc.encode('\nQ\n')));
    const add = ctx.register(ctx.flateStream(latin1(append)));
    refs.unshift(pre);
    refs.push(post, add);
  }
  page.node.set(PDFName.of('Contents'), ctx.obj(refs));
}

/** Apply text/xobject/redaction edits to a single page of a (fresh) document. */
async function applyContentEdits(bc: BuildCtx, page: PDFPage, model: PageModel, key: string, state: EditorState) {
  const tEdits = state.textEdits[key] ?? {};
  const xEdits = state.xobjEdits[key] ?? {};
  const redactions = (state.overlays[key] ?? []).filter((o) => o.type === 'redact');
  if (!Object.keys(tEdits).length && !Object.keys(xEdits).length && !redactions.length) return;

  const patches = new Map<number, StreamPatch[]>();
  const patched = new Set<string>();
  const patch = (run: { stream: number; start: number; end: number; id: string }, text: string) => {
    if (patched.has(run.id)) return;
    patched.add(run.id);
    let arr = patches.get(run.stream);
    if (!arr) patches.set(run.stream, (arr = []));
    arr.push({ start: run.start, end: run.end, text });
  };
  let append = '';

  // ---- pass 1: resolve every edit, measure it, and compute inline reflow shifts
  interface Resolved { group: TextGroup; edit: TextEdit; plan: EditPlan; text: string; encoded: MultiEncode; lf?: LibFont }
  const resolved: Resolved[] = [];
  const shifts = new Map<string, [number, number]>();
  const groupOfRun = new Map<string, TextGroup>();
  for (const g of model.groups) for (const r of g.runs) groupOfRun.set(r.id, g);
  for (const gid in tEdits) {
    const edit = tEdits[gid];
    const group = model.groups.find((g) => g.id === gid);
    if (!group) continue;
    const base = group.runs[0];
    const plan = planTextEdit(group, edit);
    const text = edit.text ?? group.text;
    const encoded = encodeGroup(group, text);
    const lf = plan.mode === 'substitute' ? await getLibFont(bc, plan.substituteFont ?? StandardFonts.Helvetica) : undefined;
    resolved.push({ group, edit, plan, text, encoded, lf });
    const restyle = !!(edit.dx || edit.dy || (edit.scale && edit.scale !== 1));
    if (edit.noReflow || restyle) continue;
    let newAdv: number;
    if (plan.mode === 'delete') newAdv = 0;
    else if (plan.mode === 'substitute') newAdv = lf!.widthOfTextAtSize(libClean(lf!, text), base.fs) * base.Th;
    else newAdv = encodedAdvance(base, encoded);
    const m = mul(base.tm, base.ctm);
    const inv = invert(m);
    const fs = Math.abs(base.fs) || 1;
    let endX = 0;
    for (const r of group.runs) {
      const rm = mul(r.tm, r.ctm);
      endX = Math.max(endX, apply(inv, ...apply(rm, r.advance, 0))[0]);
    }
    const delta = newAdv - endX;
    if (Math.abs(delta) < 0.01 * fs) continue;
    // chain of runs that continue this line (stop at the first column-sized gap)
    const cands = model.runs
      .filter((r) => !group.runs.includes(r) && r.glyphs.length)
      .map((r) => {
        const rm = mul(r.tm, r.ctm);
        const p0 = apply(inv, rm[4], rm[5]);
        const p1 = apply(inv, ...apply(rm, r.advance, 0));
        return { r, x0: Math.min(p0[0], p1[0]), x1: Math.max(p0[0], p1[0]), y: p0[1], par: Math.abs(rm[1] * m[0] - rm[0] * m[1]) < 1e-3 * (Math.abs(rm[0] * m[0]) + 1e-9) * 50 };
      })
      .filter((c) => c.par && Math.abs(c.y) < 0.25 * fs && c.x0 > endX - 0.1 * fs)
      .sort((a, b) => a.x0 - b.x0);
    let cur = endX;
    const [ux, uy] = [m[0] * delta, m[1] * delta];
    for (const c of cands) {
      if (c.x0 - cur > 1.2 * fs) break;
      cur = Math.max(cur, c.x1);
      // a whole edited group moves together, keyed by run
      const prev = shifts.get(c.r.id) ?? [0, 0];
      shifts.set(c.r.id, [prev[0] + ux, prev[1] + uy]);
    }
  }
  const textSpaceShift = (r: TextRun, s: [number, number]) => {
    const lin = mul(r.tm, r.ctm);
    const inv = invert([lin[0], lin[1], lin[2], lin[3], 0, 0]);
    return apply(inv, s[0], s[1])[0];
  };

  // ---- pass 2: write patches
  for (const { group, edit, plan, text, encoded, lf } of resolved) {
    const base = group.runs[0];
    if (plan.mode === 'delete') {
      for (const r of group.runs) patch(r, hideRun(r));
      continue;
    }
    const sh = shifts.get(base.id);
    if (plan.mode === 'inplace') {
      const adv = encodedAdvance(base, encoded);
      const lead = sh ? kernFor(base, textSpaceShift(base, sh)) : 0;
      const comp = kernFor(base, base.advance - adv) - lead;
      patch(base, opPrefix(base) + showSegments(group, encoded, base.fs, 0, lead, comp));
      for (const r of group.runs.slice(1)) patch(r, hideRun(r));
      continue;
    }
    // re-emit at the end of the page content (moved / restyled / substitute font)
    for (const r of group.runs) patch(r, hideRun(r));
    const scale = edit.scale ?? 1;
    const fs = base.fs * scale;
    const color = edit.color ? rgbOps(edit.color) : colorOps(base.color);
    const dx = (edit.dx ?? 0) + (sh?.[0] ?? 0);
    const dy = (edit.dy ?? 0) + (sh?.[1] ?? 0);
    const shift = dx || dy ? `1 0 0 1 ${fmtNum(dx)} ${fmtNum(dy)} cm ` : '';
    let fontPart: string;
    let show: string;
    if (plan.mode === 'reemit-original') {
      fontPart = `${nameToken(base.fontKey)} ${fmtNum(fs)} Tf ${fmtNum(base.Tc * scale)} Tc ${fmtNum(base.Tw * scale)} Tw`;
      show = showSegments(group, encoded, fs, 0);
    } else {
      const fk = page.node.newFontDictionary('EdF', lf!.ref).decodeText();
      fontPart = `${nameToken(fk)} ${fmtNum(fs)} Tf 0 Tc 0 Tw`;
      show = libEncode(lf!, text) + ' Tj';
    }
    append +=
      `q ${shift}${mat(base.ctm)} cm BT ${fontPart} ${fmtNum(base.Th * 100)} Tz ${fmtNum(base.Ts * scale)} Ts ${fmtNum(base.Tr)} Tr ${color} ` +
      `${mat(base.tm)} Tm ${show} ET Q\n`;
  }

  // untouched runs that must slide along their line
  for (const [rid, sh] of shifts) {
    if (patched.has(rid)) continue;
    const g = groupOfRun.get(rid);
    const run = g?.runs.find((r) => r.id === rid) ?? model.runs.find((r) => r.id === rid);
    if (!run) continue;
    const k = kernFor(run, textSpaceShift(run, sh));
    const op = model.streams[run.stream].ops[run.opIndex];
    const items = runItems(run, op.operands);
    patch(run, opPrefix(run) + tjOperand([k, ...items, -k]) + ' TJ');
  }

  for (const xid in xEdits) {
    const e = xEdits[xid];
    const xo = model.xobjects.find((x) => x.id === xid);
    if (!xo) continue;
    if (e.deleted) {
      patch(xo, '');
      continue;
    }
    if (!e.dx && !e.dy && !e.replaceAsset) continue;
    const original = model.streams[xo.stream].bytes.subarray(xo.start, xo.end);
    patch(xo, '');
    const shift = e.dx || e.dy ? `1 0 0 1 ${fmtNum(e.dx ?? 0)} ${fmtNum(e.dy ?? 0)} cm ` : '';
    if (e.replaceAsset) {
      const nm = await getImageName(bc, page, e.replaceAsset);
      if (!nm) continue;
      const m = xo.subtype === 'Image' || xo.subtype === 'Inline' ? xo.ctm : bboxMatrix(xo);
      append += `q ${shift}${mat(m)} cm ${nameToken(nm)} Do Q\n`;
    } else {
      let raw = '';
      for (let i = 0; i < original.length; i++) raw += String.fromCharCode(original[i]);
      append += `q ${shift}${mat(xo.ctm)} cm ${raw} Q\n`;
    }
  }

  // glyph-level redaction
  if (redactions.length) {
    const rects = redactions.map((r) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
    for (const run of model.runs) {
      if (patched.has(run.id)) continue;
      const hit = rects.some((r) => !(run.bbox.x1 < r.x0 || run.bbox.x0 > r.x1 || run.bbox.y1 < r.y0 || run.bbox.y0 > r.y1));
      if (!hit) continue;
      const m = mul(run.tm, run.ctm);
      const mid = run.Ts + ((run.font.ascent + run.font.descent) / 2000) * run.fs;
      const keep = (a: number, b: number) => {
        const [px, py] = apply(m, (a + b) / 2, mid);
        return !rects.some((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
      };
      const op = model.streams[run.stream].ops[run.opIndex];
      patch(run, rewriteRunKeeping(run, op.operands, keep));
    }
    for (const xo of model.xobjects) {
      if (patched.has(xo.id)) continue;
      const inside = rects.some((r) => xo.bbox.x0 >= r.x0 - 1 && xo.bbox.x1 <= r.x1 + 1 && xo.bbox.y0 >= r.y0 - 1 && xo.bbox.y1 <= r.y1 + 1);
      if (inside) patch(xo, '');
    }
  }

  writePageContent(bc.doc, page, model, patches, append);
}

function bboxMatrix(xo: XObjectRun): Matrix {
  const b = xo.bbox;
  return [b.x1 - b.x0, 0, 0, b.y1 - b.y0, b.x0, b.y0];
}

/** Local "upright in view" frame for an overlay box: maps (u right, v up) from view-top-left. */
export function uprightFrame(o: { x: number; y: number; w: number; h: number; rot: number }): { m: Matrix; W: number; H: number } {
  const r = ((o.rot % 360) + 360) % 360;
  const { x, y, w, h } = o;
  switch (r) {
    case 90: return { m: [0, 1, -1, 0, x, y], W: h, H: w };
    case 180: return { m: [-1, 0, 0, -1, x + w, y], W: w, H: h };
    case 270: return { m: [0, -1, 1, 0, x + w, y + h], W: h, H: w };
    default: return { m: [1, 0, 0, 1, x, y + h], W: w, H: h };
  }
}

async function drawOverlays(bc: BuildCtx, page: PDFPage, overlays: Overlay[]) {
  if (!overlays.length) return;
  const ctx = bc.doc.context;
  let out = '';
  const gsName = (opacity: number, multiply = false) => {
    const d = ctx.obj({ Type: 'ExtGState', ca: opacity, CA: opacity, ...(multiply ? { BM: 'Multiply' } : {}) });
    return page.node.newExtGState('EdGS', ctx.register(d)).decodeText();
  };
  for (const o of overlays) {
    try {
      out += (await drawOverlay(bc, page, o, gsName)) + ' Q\n';
    } catch (e) {
      console.warn('overlay skipped', o.type, e);
    }
  }
  const ref = ctx.register(ctx.flateStream(latin1(out)));
  // wrap existing content in q/Q so overlays start from a clean graphics state
  const raw = page.node.get(PDFName.of('Contents'));
  const r = resolve(ctx, raw);
  const list = r instanceof PDFArray ? r.asArray() : raw ? [raw] : [];
  const pre = ctx.register(ctx.flateStream(enc.encode('q\n')));
  const post = ctx.register(ctx.flateStream(enc.encode('\nQ\n')));
  page.node.set(PDFName.of('Contents'), ctx.obj(list.length ? [pre, ...list, post, ref] : [ref]));
}

async function drawOverlay(bc: BuildCtx, page: PDFPage, o: Overlay, gsName: (opacity: number, multiply?: boolean) => string): Promise<string> {
  {
    const op = o.opacity ?? 1;
    let s = 'q ';
    if (op < 1 || o.type === 'highlight') s += `${nameToken(gsName(o.type === 'highlight' ? (o.opacity ?? 0.4) : op, o.type === 'highlight'))} gs `;
    switch (o.type) {
      case 'rect':
      case 'whiteout':
      case 'redact':
      case 'highlight': {
        const fill = o.type === 'whiteout' ? [1, 1, 1] as RGB : o.type === 'redact' ? (o.fill ?? [0, 0, 0]) : o.type === 'highlight' ? (o.fill ?? [1, 0.92, 0.2]) : o.fill;
        const stroke = o.type === 'rect' ? o.stroke : null;
        if (fill) s += rgbOps(fill) + ' ';
        if (stroke) s += `${rgbOps(stroke, true)} ${fmtNum(o.lineWidth ?? 1)} w `;
        s += `${fmtNum(o.x)} ${fmtNum(o.y)} ${fmtNum(o.w)} ${fmtNum(o.h)} re ${fill && stroke ? 'B' : fill ? 'f' : stroke ? 'S' : 'n'}`;
        break;
      }
      case 'ellipse': {
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2, rx = o.w / 2, ry = o.h / 2, k = 0.5523;
        if (o.fill) s += rgbOps(o.fill) + ' ';
        if (o.stroke) s += `${rgbOps(o.stroke, true)} ${fmtNum(o.lineWidth ?? 1)} w `;
        const f = fmtNum;
        s += `${f(cx + rx)} ${f(cy)} m ${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ` +
          `${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c ` +
          `${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ` +
          `${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c `;
        s += o.fill && o.stroke ? 'B' : o.fill ? 'f' : o.stroke ? 'S' : 'n';
        break;
      }
      case 'line':
      case 'arrow': {
        s += `${rgbOps(o.stroke, true)} ${fmtNum(o.lineWidth)} w 1 J ${fmtNum(o.x1)} ${fmtNum(o.y1)} m ${fmtNum(o.x2)} ${fmtNum(o.y2)} l S`;
        if (o.type === 'arrow') {
          const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
          const L = Math.max(6, o.lineWidth * 4);
          const p1 = [o.x2 - L * Math.cos(ang - 0.45), o.y2 - L * Math.sin(ang - 0.45)];
          const p2 = [o.x2 - L * Math.cos(ang + 0.45), o.y2 - L * Math.sin(ang + 0.45)];
          s += ` ${rgbOps(o.stroke)} ${fmtNum(o.x2)} ${fmtNum(o.y2)} m ${fmtNum(p1[0])} ${fmtNum(p1[1])} l ${fmtNum(p2[0])} ${fmtNum(p2[1])} l h f`;
        }
        break;
      }
      case 'ink': {
        s += `${rgbOps(o.stroke, true)} ${fmtNum(o.lineWidth)} w 1 J 1 j `;
        for (const st of o.points) {
          if (st.length < 2) continue;
          s += `${fmtNum(st[0])} ${fmtNum(st[1])} m `;
          if (st.length === 2) s += `${fmtNum(st[0] + 0.01)} ${fmtNum(st[1])} l `;
          for (let i = 2; i + 1 < st.length; i += 2) s += `${fmtNum(st[i])} ${fmtNum(st[i + 1])} l `;
          s += 'S ';
        }
        break;
      }
      case 'image': {
        const nm = await getImageName(bc, page, o.asset);
        if (!nm) break;
        const { m, W, H } = uprightFrame(o);
        // unit square -> box, upright in view
        const u = [m[0], m[1]], v = [m[2], m[3]];
        const im: Matrix = [W * u[0], W * u[1], H * v[0], H * v[1], m[4] - H * v[0], m[5] - H * v[1]];
        s += `${mat(im)} cm ${nameToken(nm)} Do`;
        break;
      }
      case 'text': {
        const lf = await getLibFont(bc, o.font);
        const fk = page.node.newFontDictionary('EdF', lf.ref).decodeText();
        const { m, W } = uprightFrame(o);
        const lh = o.size * 1.2;
        const asc = lf.heightAtSize(o.size, { descender: false });
        s += `${mat(m)} cm BT ${nameToken(fk)} ${fmtNum(o.size)} Tf ${rgbOps(o.color)} `;
        const lines = o.text.split('\n');
        lines.forEach((line, i) => {
          const lw = lf.widthOfTextAtSize(libClean(lf, line), o.size);
          const x = o.align === 'center' ? (W - lw) / 2 : o.align === 'right' ? W - lw : 0;
          s += `1 0 0 1 ${fmtNum(x)} ${fmtNum(-asc - i * lh)} Tm ${libEncode(lf, line)} Tj `;
        });
        s += 'ET';
        break;
      }
    }
    return s;
  }
}

export interface BuildOptions {
  /** used for export: drop the object-stream compression for maximum compatibility */
  compat?: boolean;
}

/** Build the output PDF from pristine sources + state. */
export async function buildPdf(
  sources: Map<string, SourceDoc>,
  primaryId: string,
  state: EditorState,
  assets: Map<string, Asset>,
  opts: BuildOptions = {},
): Promise<Uint8Array> {
  const fresh = new Map<string, PDFDocument>();
  const load = async (id: string) => {
    let d = fresh.get(id);
    if (!d) {
      d = await PDFDocument.load(sources.get(id)!.info.bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
      d.registerFontkit(fontkit);
      fresh.set(id, d);
    }
    return d;
  };
  const primary = await load(primaryId);
  const ctxFor = new Map<PDFDocument, BuildCtx>();
  const bcOf = (doc: PDFDocument): BuildCtx => {
    let bc = ctxFor.get(doc);
    if (!bc) ctxFor.set(doc, (bc = { doc, stdFonts: new Map(), customFonts: new Map(), assets, images: new Map() }));
    return bc;
  };

  // 1. content edits on source pages
  const pageObjs = new Map<string, PDFPage>();
  for (const slot of state.pages) {
    if (slot.key.startsWith('blank:')) continue;
    const [sid, idxS] = slot.key.split(':');
    const src = sources.get(sid);
    if (!src) continue;
    const doc = await load(sid);
    const idx = Number(idxS);
    const page = doc.getPage(idx);
    try {
      await applyContentEdits(bcOf(doc), page, src.model(idx), slot.key, state);
    } catch (e) {
      console.warn('content edits skipped for', slot.key, e);
    }
    pageObjs.set(slot.key, page);
  }
  // make sure everything embedded in secondary docs exists before copying
  for (const [doc, bc] of ctxFor) {
    if (doc === primary) continue;
    for (const f of [...bc.stdFonts.values(), ...bc.customFonts.values()]) await f.embed();
  }

  // 2. bring pages from other sources into the primary document
  for (const [sid, doc] of fresh) {
    if (sid === primaryId) continue;
    const wanted = state.pages.filter((p) => p.key.startsWith(sid + ':'));
    const copied = await primary.copyPages(doc, wanted.map((p) => Number(p.key.split(':')[1])));
    wanted.forEach((p, i) => pageObjs.set(p.key, copied[i]));
  }

  // 3. arrange pages (skipped when the original order is untouched)
  const untouched = state.pages.length === primary.getPageCount() && state.pages.every((p, i) => p.key === `${primaryId}:${i}`);
  if (!untouched) {
    for (let i = primary.getPageCount() - 1; i >= 0; i--) primary.removePage(i);
    for (const slot of state.pages) {
      let page = pageObjs.get(slot.key);
      if (!page) {
        const [w, h] = slot.size ?? [612, 792];
        page = primary.addPage([w, h]);
        pageObjs.set(slot.key, page);
      } else primary.addPage(page);
    }
  }
  for (const slot of state.pages) {
    const page = pageObjs.get(slot.key)!;
    if (slot.rotate) page.setRotation(degrees((((page.getRotation().angle + slot.rotate) % 360) + 360) % 360));
  }

  // 4. overlays (in the primary document context)
  const pbc = bcOf(primary);
  for (const slot of state.pages) {
    const page = pageObjs.get(slot.key)!;
    const ovs = (state.overlays[slot.key] ?? []).slice();
    if (!ovs.length) continue;
    await drawOverlays(pbc, page, ovs.filter((o) => o.type !== 'redact').concat(ovs.filter((o) => o.type === 'redact')));
  }

  // 5. forms
  if (Object.keys(state.forms).length || state.flattenForms) {
    try {
      const form = primary.getForm();
      for (const name in state.forms) {
        const v = state.forms[name];
        try {
          const f = form.getField(name);
          if (f instanceof PDFTextField) f.setText(String(v));
          else if (f instanceof PDFCheckBox) (v ? f.check() : f.uncheck());
          else if (f instanceof PDFDropdown || f instanceof PDFOptionList) f.select(v as string);
          else if (f instanceof PDFRadioGroup) f.select(String(v));
        } catch (e) {
          console.warn('form field', name, e);
        }
      }
      if (state.flattenForms) form.flatten();
    } catch (e) {
      console.warn('form', e);
    }
  }

  // 6. metadata
  const m = state.meta;
  if (m.title !== undefined) primary.setTitle(m.title);
  if (m.author !== undefined) primary.setAuthor(m.author);
  if (m.subject !== undefined) primary.setSubject(m.subject);
  if (m.keywords !== undefined) primary.setKeywords(m.keywords.split(',').map((s) => s.trim()).filter(Boolean));

  return primary.save({ useObjectStreams: !opts.compat, updateFieldAppearances: true });
}

// ---------------------------------------------------------------------------
// Form field discovery
// ---------------------------------------------------------------------------
export interface FieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'list' | 'button' | 'signature' | 'unknown';
  value: string | boolean | string[];
  options?: string[];
  multiline?: boolean;
}

export function listFields(doc: PDFDocument): FieldInfo[] {
  try {
    const form = doc.getForm();
    return form.getFields().map((f): FieldInfo => {
      const name = f.getName();
      try {
        if (f instanceof PDFTextField) return { name, type: 'text', value: f.getText() ?? '', multiline: f.isMultiline() };
        if (f instanceof PDFCheckBox) return { name, type: 'checkbox', value: f.isChecked() };
        if (f instanceof PDFDropdown) return { name, type: 'dropdown', value: f.getSelected()[0] ?? '', options: f.getOptions() };
        if (f instanceof PDFOptionList) return { name, type: 'list', value: f.getSelected()[0] ?? '', options: f.getOptions() };
        if (f instanceof PDFRadioGroup) return { name, type: 'radio', value: f.getSelected() ?? '', options: f.getOptions() };
        if (f instanceof PDFButton) return { name, type: 'button', value: '' };
        if (f instanceof PDFSignature) return { name, type: 'signature', value: '' };
      } catch {
        /* fallthrough */
      }
      return { name, type: 'unknown', value: '' };
    });
  } catch {
    return [];
  }
}

export type { PdfFont };
