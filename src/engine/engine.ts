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
  PDFRef as PDFRefClass,
  type PDFRef,
  type PDFObject,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Encodings } from '@pdf-lib/standard-fonts';
import { FontCache, type PdfFont } from './fonts.ts';
import { planLine, type FontSlot, type Piece, type FallbackPrefs } from './textedit.ts';
import { detectAlignment } from './layout.ts';
import { parseFontProgram } from './fontprog.ts';

/** Coverage check for uploaded / fetched fallback fonts (`asset:<id>`), cached per asset. */
const coverCache = new Map<string, Map<number, number> | null>();
export function fallbackPrefs(state: EditorState, assets: Map<string, Asset>): FallbackPrefs {
  return {
    matches: state.fontMatches ?? {},
    covers: (font, ch) => {
      if (!font.startsWith('asset:')) return true;
      const id = font.slice(6);
      if (!coverCache.has(id)) {
        const a = assets.get(id);
        coverCache.set(id, a ? parseFontProgram(a.bytes, 'FontFile2')?.unicodeCmap ?? null : null);
      }
      const cm = coverCache.get(id);
      return !cm || cm.has(ch.codePointAt(0)!);
    },
  };
}
import { interpretPage, mul, apply, invert, IDENTITY, type BBox, type Matrix, type PageModel, type TextGroup, type TextRun, type XObjectRun, type FillColor } from './interpreter.ts';
import { fmtNum, hexString, latin1, nameToken, type Operand } from './lexer.ts';
import type { Asset, EditorState, Overlay, RGB, TextEdit, Watermark } from './model.ts';
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
        m = { streams: [], runs: [], xobjects: [], groups: [], blocks: [], annots: [], paints: [] };
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
  /** inplace: only changed glyphs rewritten; reemit-original: restyled in the original fonts;
   *  substitute: some characters had to come from a fallback font (only those characters) */
  mode: 'inplace' | 'reemit-original' | 'substitute' | 'delete';
  /** characters drawn with a fallback font */
  missing: string[];
  substituteFont?: string;
  /** characters borrowed from another subset of the same typeface in the document */
  borrowed: string[];
  /** characters each embedded font is missing (by font display name) */
  missingByFont: Record<string, string[]>;
}

export function planTextEdit(group: TextGroup, edit: TextEdit, pool: PdfFont[] = [], prefs: FallbackPrefs = {}): EditPlan {
  if (edit.deleted) return { mode: 'delete', missing: [], borrowed: [], missingByFont: {} };
  const lp = planLine(group, edit, pool, prefs);
  if (lp.fallbackChars.length || edit.forceFallback)
    return { mode: 'substitute', missing: lp.fallbackChars, substituteFont: lp.fallbackFonts.join(', '), borrowed: lp.borrowedChars, missingByFont: lp.missingByFont };
  return { mode: lp.restyle ? 'reemit-original' : 'inplace', missing: [], borrowed: lp.borrowedChars, missingByFont: {} };
}

// ---------------------------------------------------------------------------
// Bundled fallback fonts (registered by the host: UI bundle or tests)
// ---------------------------------------------------------------------------
const bundled = new Map<string, Uint8Array>();
export function registerBundledFont(name: string, bytes: Uint8Array) {
  bundled.set(name, bytes);
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
  images: Map<string, { ref: PDFRef; w: number; h: number }>;
  /** fonts of the source document (glyphs can be borrowed from same-face subsets) */
  pool: PdfFont[];
}

async function getLibFont(bc: BuildCtx, name: string): Promise<LibFont> {
  if (name.startsWith('bundled:')) {
    let f = bc.customFonts.get(name);
    if (!f) {
      const bytes = bundled.get(name.slice(8));
      if (!bytes) return getLibFont(bc, /Serif/.test(name) ? (/Bold/.test(name) ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman) : /Bold/.test(name) ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
      f = await bc.doc.embedFont(bytes, { subset: true });
      bc.customFonts.set(name, f);
    }
    return f;
  }
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

async function getImage(bc: BuildCtx, page: PDFPage, assetId: string): Promise<{ name: string; w: number; h: number } | undefined> {
  let im = bc.images.get(assetId);
  if (!im) {
    const a = bc.assets.get(assetId);
    if (!a) return undefined;
    const img = a.kind === 'png' ? await bc.doc.embedPng(a.bytes) : await bc.doc.embedJpg(a.bytes);
    await img.embed();
    im = { ref: img.ref, w: img.width, h: img.height };
    bc.images.set(assetId, im);
  }
  return { name: page.node.newXObject('EdIm', im.ref).decodeText(), w: im.w, h: im.h };
}
async function getImageName(bc: BuildCtx, page: PDFPage, assetId: string): Promise<string | undefined> {
  return (await getImage(bc, page, assetId))?.name;
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
  const removals = state.removals?.[key] ?? [];
  if (!Object.keys(tEdits).length && !Object.keys(xEdits).length && !redactions.length && !removals.length) return;
  const ctx = bc.doc.context;
  const alphaGs = (a: number) =>
    page.node.newExtGState('EdGS', ctx.register(ctx.obj({ Type: 'ExtGState', ca: a, CA: a }))).decodeText();

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

  // ---- removals from the watermark manager (applied first so they win over other patches)
  for (const t of removals) {
    if (t.startsWith('group:')) {
      const g = model.groups.find((x) => x.id === t.slice(6));
      if (g) for (const r of g.runs) patch(r, hideRun(r));
    } else if (t.startsWith('xo:')) {
      const xo = model.xobjects.find((x) => x.id === t.slice(3));
      if (xo) patch(xo, '');
    } else if (t.startsWith('mc:')) {
      const b = model.blocks.find((x) => x.id === t);
      if (!b) continue;
      // keep only structural operators so q/Q, BT/ET and marked content stay balanced
      const st = model.streams[b.stream];
      let keep = '';
      for (let k = b.startOp; k <= b.endOp; k++) {
        const op = st.ops[k];
        if (['q', 'Q', 'BT', 'ET', 'BDC', 'BMC', 'EMC'].includes(op.op)) {
          let raw = '';
          const bytes = st.bytes.subarray(op.start, op.end);
          for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
          keep += raw + '\n';
        }
      }
      patch({ id: b.id, stream: b.stream, start: b.start, end: b.end }, keep);
    } else if (t.startsWith('annot:')) {
      const ref = t.slice(6);
      const annots = page.node.Annots();
      if (annots) for (let i = annots.size() - 1; i >= 0; i--) {
        const a = annots.get(i);
        const k = a instanceof PDFRefClass ? `${a.objectNumber}_${a.generationNumber}` : `d${i}`;
        if (k === ref) annots.remove(i);
      }
    }
  }

  // ---- text edits: glyph-level diff, only changed glyphs are rewritten
  const textSpaceShift = (r: TextRun, sh: [number, number]) => {
    const lin = mul(r.tm, r.ctm);
    const inv = invert([lin[0], lin[1], lin[2], lin[3], 0, 0]);
    return apply(inv, sh[0], sh[1])[0];
  };
  const unitDir = (r: TextRun): [number, number] => {
    const m = mul(r.tm, r.ctm);
    const l = Math.hypot(m[0], m[1]) || 1;
    return [m[0] / l, m[1] / l];
  };
  const borrowKeys = new Map<PdfFont, string>();
  const libKeys = new Map<string, { key: string; font: LibFont }>();
  const slotKey = async (slot: FontSlot): Promise<string> => {
    if (slot.kind === 'orig') return slot.key;
    if (slot.kind === 'borrow') {
      let k = borrowKeys.get(slot.font);
      if (!k) borrowKeys.set(slot.font, (k = page.node.newFontDictionary('EdB', slot.font.ref!).decodeText()));
      return k;
    }
    let e = libKeys.get(slot.name);
    if (!e) {
      const font = await getLibFont(bc, slot.name);
      e = { key: page.node.newFontDictionary('EdF', font.ref).decodeText(), font };
      libKeys.set(slot.name, e);
    }
    return e.key;
  };
  /** text-space advance of a run's new pieces (using the run's own Tc/Tw/Tz) */
  const piecesAdvance = async (run: TextRun, pieces: Piece[]) => {
    let adv = 0;
    for (const pc of pieces) {
      if (pc.slot.kind === 'lib') {
        await slotKey(pc.slot);
        const lf = libKeys.get(pc.slot.name)!.font;
        const txt = libClean(lf, pc.text);
        const singleByte = STANDARD_FONT_NAMES.includes(pc.slot.name);
        adv += (lf.widthOfTextAtSize(txt, run.fs) + Array.from(txt).length * run.Tc + (singleByte ? (txt.match(/ /g)?.length ?? 0) * run.Tw : 0)) * run.Th;
        continue;
      }
      let gi = 0;
      for (const it of pc.items) {
        if (typeof it === 'number') adv += (-it / 1000) * run.fs * run.Th;
        else {
          const f = (pc.slot as { font: PdfFont }).font;
          // count glyphs in this string using the font's own code length
          for (const g of f.decode(it)) {
            void g;
            const gl = pc.glyphs[gi++];
            adv += (((gl?.width ?? 0) / 1000) * run.fs + run.Tc + (gl?.isSpace ? run.Tw : 0)) * run.Th;
          }
        }
      }
    }
    return adv;
  };
  /** operators that show the pieces, starting and ending in the run's own font */
  const piecesOps = async (run: TextRun, pieces: Piece[], lead: number, tail: number) => {
    let s = '';
    let cur = run.fontKey;
    if (Math.abs(lead) > 1e-6) s += `[${fmtNum(lead)}] TJ `;
    for (const pc of pieces) {
      const k = await slotKey(pc.slot);
      if (k !== cur) {
        s += `${nameToken(k)} ${fmtNum(run.fs)} Tf `;
        cur = k;
      }
      if (pc.slot.kind === 'lib') s += `${libEncode(libKeys.get(pc.slot.name)!.font, pc.text)} Tj `;
      else if (pc.items.length) s += tjOperand(pc.items) + ' TJ ';
    }
    if (Math.abs(tail) > 1e-6) s += `[${fmtNum(tail)}] TJ `;
    if (cur !== run.fontKey) s += `${nameToken(run.fontKey)} ${fmtNum(run.fs)} Tf `;
    return s.trim() || '[] TJ';
  };

  /**
   * Type 3 fonts: viewers disagree on how TJ kerning is scaled for them (poppler applies the font
   * matrix), so every glyph is placed with an explicit text matrix instead – identical in all viewers.
   * Only valid inside a text object we opened ourselves.
   */
  const placedOps = async (run: TextRun, pieces: Piece[], lead: number) => {
    let s = '';
    let cur = run.fontKey;
    let x = (-lead / 1000) * run.fs * run.Th;
    const at = () => `${mat(mul([1, 0, 0, 1, x, 0], run.tm))} Tm `;
    for (const pc of pieces) {
      const k = await slotKey(pc.slot);
      if (k !== cur) {
        s += `${nameToken(k)} ${fmtNum(run.fs)} Tf `;
        cur = k;
      }
      if (pc.slot.kind === 'lib') {
        const lf = libKeys.get(pc.slot.name)!.font;
        const txt = libClean(lf, pc.text);
        s += at() + `${lf.encodeText(txt).toString()} Tj `;
        x += (lf.widthOfTextAtSize(txt, run.fs) + Array.from(txt).length * run.Tc) * run.Th;
        continue;
      }
      const f = pc.slot.font;
      for (const it of pc.items) {
        if (typeof it === 'number') { x += (-it / 1000) * run.fs * run.Th; continue; }
        for (const g of f.decode(it)) {
          s += at() + `${hexString(g.bytes)} Tj `;
          x += ((g.width / 1000) * run.fs + run.Tc + (g.isSpace ? run.Tw : 0)) * run.Th;
        }
      }
    }
    if (cur !== run.fontKey) s += `${nameToken(run.fontKey)} ${fmtNum(run.fs)} Tf `;
    return s.trim();
  };
  const isT3 = (run: TextRun, pieces: Piece[]) => run.font.isType3 || pieces.some((pc) => pc.slot.kind !== 'lib' && pc.slot.font.isType3);
  /** state needed to continue the original text object after we closed it */
  const restoreAfter = (run: TextRun) => {
    const tmAfter = mul([1, 0, 0, 1, run.advance, 0], run.tm);
    const R = mul(tmAfter, invert(run.tlm));
    if (Math.abs(R[0] - 1) + Math.abs(R[1]) + Math.abs(R[2]) + Math.abs(R[3] - 1) + Math.abs(R[5]) < 1e-6) {
      const k = kernFor(run, R[4]);
      return `${mat(run.tlm)} Tm` + (Math.abs(k) > 1e-6 ? ` [${fmtNum(k)}] TJ` : '');
    }
    return `${mat(tmAfter)} Tm`;
  };
  /** hide the run and redraw it at the same place in the stream inside its own state */
  const inlineRedraw = (run: TextRun, show: string, pre = '') => {
    patch(run, hideRun(run));
    const prev = patches.get(run.stream)!.find((p) => p.start === run.start)!;
    prev.text += ` ET q ${pre}BT ${mat(run.tm)} Tm ${show} ET Q BT ${restoreAfter(run)}`;
  };
  const own = (run: TextRun): Piece[] => [{ slot: { kind: 'orig', key: run.fontKey, font: run.font }, items: run.items, text: '', glyphs: [] }];

  const shifts = new Map<string, [number, number]>();
  const pool = bc.pool;

  /** how much each run's width changes (user units along the line), with the same rules used when writing */
  const runDeltas = async (lp: ReturnType<typeof planLine>) => {
    const out: number[] = [];
    for (let i = 0; i < lp.runs.length; i++) {
      const rp = lp.runs[i];
      const run = rp.run;
      if (!rp.changed) { out.push(0); continue; }
      const newAdv = await piecesAdvance(run, rp.pieces);
      const lin = mul(run.tm, run.ctm);
      let d = (newAdv - run.advance) * Math.hypot(lin[0], lin[1]) - rp.gapRemoved;
      const next = lp.runs[i + 1]?.run;
      if (!rp.pieces.some((pc) => pc.items.some((it) => typeof it !== 'number') || pc.text) && next) {
        const [dx, dy] = unitDir(run);
        const a0 = apply(mul(run.tm, run.ctm), 0, 0), b0 = apply(mul(next.tm, next.ctm), 0, 0);
        d = -((b0[0] - a0[0]) * dx + (b0[1] - a0[1]) * dy) - rp.gapRemoved;
      }
      out.push(d);
    }
    return out;
  };
  /** original visual width of a line (user units along its baseline) */
  const lineWidth = (group: TextGroup) => {
    const base = group.runs[0];
    const m = mul(base.tm, base.ctm);
    const inv = invert(m);
    let endX = 0;
    for (const r of group.runs) endX = Math.max(endX, apply(inv, ...apply(mul(r.tm, r.ctm), r.advance, 0))[0]);
    return endX * Math.hypot(m[0], m[1]);
  };
  const pageBox = page.getCropBox();

  /** glyph box of a run drawn from text-space x0 to x1 (optionally moved through userM), in user space */
  const glyphBox = (run: TextRun, x0: number, x1: number, userM?: Matrix): BBox => {
    let m = mul(run.tm, run.ctm);
    if (userM) m = mul(m, userM);
    const top = run.Ts + (run.font.ascent / 1000) * run.fs, bot = run.Ts + (run.font.descent / 1000) * run.fs;
    const pts = [apply(m, x0, bot), apply(m, x1, bot), apply(m, x1, top), apply(m, x0, top)];
    return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
  };
  const overlapArea = (a: BBox, b: BBox) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  /**
   * Must the edited run be drawn on top of the page instead of in place? True when, at its new size/position,
   *  - it would be cut by its clipping box on a side the original stayed inside of, or
   *  - it would slide under something painted after it (a white bar, a rule, a box background…) that it
   *    didn't overlap before – that later paint would rub out part of the letters.
   */
  const overflows = (run: TextRun, x0: number, x1: number, userM?: Matrix) => {
    const ob = glyphBox(run, 0, run.advance);
    const nb = glyphBox(run, x0, x1, userM);
    const c = run.clip;
    if (c) {
      const t = 0.5;
      if (ob.x0 >= c.x0 - t && nb.x0 < c.x0 - t) return true;
      if (ob.x1 <= c.x1 + t && nb.x1 > c.x1 + t) return true;
      if (ob.y0 >= c.y0 - t && nb.y0 < c.y0 - t) return true;
      if (ob.y1 <= c.y1 + t && nb.y1 > c.y1 + t) return true;
    }
    const area = Math.max(1e-6, (nb.x1 - nb.x0) * (nb.y1 - nb.y0));
    for (const p of model.paints) {
      if (p.stream < run.stream || (p.stream === run.stream && p.opIndex <= run.opIndex)) continue;
      const pa = (p.bbox.x1 - p.bbox.x0) * (p.bbox.y1 - p.bbox.y0);
      if (pa > 0.6 * pageBox.width * pageBox.height) continue; // full-page layers covered the original too
      const now = overlapArea(nb, p.bbox), before = overlapArea(ob, p.bbox);
      if (now - before > 0.004 * area + 0.05) return true;
    }
    return false;
  };
  /**
   * Text that would be cut off by its clipping box (e.g. a web page's overflow:hidden container)
   * is drawn after the page content, outside the clip, with its exact colour and opacity.
   */
  const escapeRun = (run: TextRun, show: string, userM?: Matrix, color?: string, gsOp = '') => {
    patch(run, hideRun(run));
    const alpha = !gsOp && run.alpha < 1 ? `${nameToken(alphaGs(run.alpha))} gs ` : gsOp;
    append += `q ${alpha}${userM ? mat(userM) + ' cm ' : ''}${mat(run.ctm)} cm BT ${nameToken(run.fontKey)} ${fmtNum(run.fs)} Tf ${fmtNum(run.Tc)} Tc ${fmtNum(run.Tw)} Tw ${fmtNum(run.Th * 100)} Tz ${fmtNum(run.Ts)} Ts ${fmtNum(run.Tr)} Tr ${color ?? colorOps(run.color)} ${mat(run.tm)} Tm ${show} ET Q\n`;
  };

  for (const gid in tEdits) {
    let edit = tEdits[gid];
    const group = model.groups.find((g) => g.id === gid);
    if (!group) continue;
    if (edit.deleted) {
      for (const r of group.runs) patch(r, hideRun(r));
      continue;
    }
    if (edit.fit) {
      // shrink to the original line width (anchored at the start of the line)
      const lp0 = planLine(group, { ...edit, fit: undefined }, pool, fallbackPrefs(state, bc.assets));
      let w0 = 0, w1 = 0;
      for (const rp of lp0.runs) {
        const lin = mul(rp.run.tm, rp.run.ctm);
        const k = Math.hypot(lin[0], lin[1]);
        w0 += rp.run.advance * k;
        w1 += (rp.changed ? await piecesAdvance(rp.run, rp.pieces) : rp.run.advance) * k - rp.gapRemoved;
      }
      if (edit.frame) w0 = Math.max(1, edit.frame[1] - edit.frame[0]);
      if (w1 > w0 * 1.001 && w1 > 0) edit = { ...edit, scale: (edit.scale ?? 1) * (w0 / w1) };
    }
    const lp = planLine(group, edit, pool, fallbackPrefs(state, bc.assets));
    const base = group.runs[0];
    const reflow = !edit.noReflow && !(edit.dx || edit.dy || edit.rotate || (edit.scale && edit.scale !== 1));

    // alignment: where the edited line starts inside its box (keeps centred / right-aligned text in place)
    const deltas = await runDeltas(lp);
    const W0 = lineWidth(group);
    const W1 = (W0 + deltas.reduce((a, b) => a + b, 0)) * (edit.scale ?? 1);
    const align = edit.align && edit.align !== 'auto' ? edit.align : detectAlignment(group, model.groups, { x: pageBox.x, w: pageBox.width }).align;
    const frame = edit.frame ?? [0, W0];
    const startOff = edit.noReflow ? 0 : align === 'center' ? (frame[0] + frame[1]) / 2 - W1 / 2 : align === 'right' ? frame[1] - W1 : frame[0];
    const [bdx, bdy] = unitDir(base);
    const S0: [number, number] = Math.abs(startOff) > 0.005 ? [bdx * startOff, bdy * startOff] : [0, 0];

    if (!lp.restyle) {
      // in place: changed runs are rewritten inside their own operator (own font, colour and state);
      // their end point is restored so nothing else moves implicitly, and following runs slide explicitly
      let S: [number, number] = S0;
      for (const rp of lp.runs) {
        const run = rp.run;
        const lead = (reflow || S0[0] || S0[1]) && (S[0] || S[1]) ? kernFor(run, textSpaceShift(run, S)) : 0;
        if (rp.changed) {
          const newAdv = await piecesAdvance(run, rp.pieces);
          const leadDisp = (-lead / 1000) * run.fs * run.Th;
          const tail = kernFor(run, run.advance - newAdv - leadDisp);
          if (isT3(run, rp.pieces)) {
            const show = await placedOps(run, rp.pieces, lead);
            if (overflows(run, leadDisp, leadDisp + newAdv)) escapeRun(run, show);
            else inlineRedraw(run, show);
          } else if (overflows(run, leadDisp, leadDisp + newAdv)) escapeRun(run, await piecesOps(run, rp.pieces, lead, 0));
          else patch(run, opPrefix(run) + (await piecesOps(run, rp.pieces, lead, tail)));
          if (reflow) {
            const [dx, dy] = unitDir(run);
            const lin = mul(run.tm, run.ctm);
            const scale = Math.hypot(lin[0], lin[1]);
            let d = (newAdv - run.advance) * scale - rp.gapRemoved;
            // a run deleted entirely takes the spacing to the next run with it (its kerning pair is gone)
            const next = lp.runs[lp.runs.indexOf(rp) + 1]?.run;
            if (!rp.pieces.some((pc) => pc.items.some((it) => typeof it !== 'number') || pc.text) && next) {
              const a0 = apply(mul(run.tm, run.ctm), 0, 0), b0 = apply(mul(next.tm, next.ctm), 0, 0);
              d = -((b0[0] - a0[0]) * dx + (b0[1] - a0[1]) * dy) - rp.gapRemoved;
            }
            S = [S[0] + dx * d, S[1] + dy * d];
          }
        } else if (Math.abs(lead) > 1e-6) {
          const leadDisp = (-lead / 1000) * run.fs * run.Th;
          if (run.font.isType3) {
            const show = await placedOps(run, own(run), lead);
            if (overflows(run, leadDisp, leadDisp + run.advance)) escapeRun(run, show);
            else inlineRedraw(run, show);
          } else if (overflows(run, leadDisp, leadDisp + run.advance)) escapeRun(run, tjOperand([lead, ...run.items]) + ' TJ');
          else patch(run, opPrefix(run) + tjOperand([lead, ...run.items, -lead]) + ' TJ');
        }
      }
      // the rest of the visual line (other groups/columns stay put)
      if (reflow && Math.hypot(S[0], S[1]) > 0.01) {
        const m = mul(base.tm, base.ctm);
        const inv = invert(m);
        const fs = Math.abs(base.fs) || 1;
        let endX = 0;
        for (const r of group.runs) endX = Math.max(endX, apply(inv, ...apply(mul(r.tm, r.ctm), r.advance, 0))[0]);
        const cands = model.runs
          .filter((r) => !group.runs.includes(r) && r.glyphs.length)
          .map((r) => {
            const rm = mul(r.tm, r.ctm);
            const p0 = apply(inv, rm[4], rm[5]);
            const p1 = apply(inv, ...apply(rm, r.advance, 0));
            return { r, x0: Math.min(p0[0], p1[0]), x1: Math.max(p0[0], p1[0]), y: p0[1], par: Math.abs(Math.atan2(rm[1], rm[0]) - Math.atan2(m[1], m[0])) < 0.02 };
          })
          .filter((c) => c.par && Math.abs(c.y) < 0.25 * fs && c.x0 > endX - 0.1 * fs)
          .sort((a, b) => a.x0 - b.x0);
        let cur = endX;
        for (const c of cands) {
          if (c.x0 - cur > 1.2 * fs) break;
          cur = Math.max(cur, c.x1);
          const prev = shifts.get(c.r.id) ?? [0, 0];
          shifts.set(c.r.id, [prev[0] + S[0], prev[1] + S[1]]);
        }
      }
      continue;
    }

    // restyled (moved / scaled / rotated / recoloured / opacity / forced fallback):
    // every run is hidden and redrawn at its own spot in the stream, inheriting its own state
    let userM: Matrix = [1, 0, 0, 1, (edit.dx ?? 0) + S0[0], (edit.dy ?? 0) + S0[1]];
    const [px, py] = apply(mul(base.tm, base.ctm), 0, 0);
    const sc = edit.scale ?? 1;
    const a = ((edit.rotate ?? 0) * Math.PI) / 180;
    if (sc !== 1 || a) userM = mul(mul(mul([1, 0, 0, 1, -px, -py], [sc * Math.cos(a), sc * Math.sin(a), -sc * Math.sin(a), sc * Math.cos(a), 0, 0]), [1, 0, 0, 1, px, py]), userM);
    const ident = Math.abs(userM[0] - 1) + Math.abs(userM[1]) + Math.abs(userM[2]) + Math.abs(userM[3] - 1) + Math.abs(userM[4]) + Math.abs(userM[5]) < 1e-9;
    const gsOp = edit.opacity !== undefined ? `${nameToken(alphaGs(edit.opacity))} gs ` : '';
    let S: [number, number] = [0, 0];
    for (const rp of lp.runs) {
      const run = rp.run;
      const lead = S[0] || S[1] ? kernFor(run, textSpaceShift(run, S)) : 0;
      const newAdv = await piecesAdvance(run, rp.pieces);
      {
        const [dx, dy] = unitDir(run);
        const lin = mul(run.tm, run.ctm);
        const d = (newAdv - run.advance) * Math.hypot(lin[0], lin[1]) - rp.gapRemoved;
        S = [S[0] + dx * d, S[1] + dy * d];
      }
      const show = isT3(run, rp.pieces) ? await placedOps(run, rp.pieces, lead) : await piecesOps(run, rp.pieces, lead, 0);
      const stroked = [1, 2, 5, 6].includes(run.Tr);
      const state = edit.color ? rgbOps(edit.color) + ' ' + (stroked ? rgbOps(edit.color, true) + ' ' : '') : '';
      const leadDisp = (-lead / 1000) * run.fs * run.Th;
      if (run.Tr < 4 && !overflows(run, leadDisp, leadDisp + newAdv, ident ? undefined : userM)) {
        patch(run, hideRun(run));
        const local = ident ? '' : `${mat(mul(mul(run.ctm, userM), invert(run.ctm)))} cm `;
        const tmAfter = mul([1, 0, 0, 1, run.advance, 0], run.tm);
        const R = mul(tmAfter, invert(run.tlm));
        let restore: string;
        if (Math.abs(R[0] - 1) + Math.abs(R[1]) + Math.abs(R[2]) + Math.abs(R[3] - 1) + Math.abs(R[5]) < 1e-6) {
          const k = kernFor(run, R[4]);
          restore = `${mat(run.tlm)} Tm` + (Math.abs(k) > 1e-6 ? ` [${fmtNum(k)}] TJ` : '');
        } else restore = `${mat(tmAfter)} Tm`;
        const prev = patches.get(run.stream)!.find((p) => p.start === run.start)!;
        prev.text += ` ET q ${gsOp}${local}BT ${mat(run.tm)} Tm ${state}${show} ET Q BT ${restore}`;
      } else {
        // clipping text modes, or the text would be cut off by its clip box: draw after the page content
        escapeRun(run, show, ident ? undefined : userM, edit.color ? rgbOps(edit.color) : undefined, gsOp);
      }
    }
  }

  // untouched runs that must slide along their line
  for (const [rid, sh] of shifts) {
    if (patched.has(rid)) continue;
    const run = model.runs.find((r) => r.id === rid);
    if (!run) continue;
    const k = kernFor(run, textSpaceShift(run, sh));
    const kd = (-k / 1000) * run.fs * run.Th;
    if (run.font.isType3) {
      const show = await placedOps(run, own(run), k);
      if (overflows(run, kd, kd + run.advance)) escapeRun(run, show);
      else inlineRedraw(run, show);
    } else if (overflows(run, kd, kd + run.advance)) escapeRun(run, tjOperand([k, ...run.items]) + ' TJ');
    else patch(run, opPrefix(run) + tjOperand([k, ...run.items, -k]) + ' TJ');
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
    // redraw in place (same graphics state: opacity, blend, clip and stacking order are kept)
    const T: Matrix = [1, 0, 0, 1, e.dx ?? 0, e.dy ?? 0];
    const inv = invert(xo.ctm);
    if (e.replaceAsset) {
      const im = await getImage(bc, page, e.replaceAsset);
      if (!im) continue;
      const target = xo.subtype === 'Form' ? mul(bboxMatrix(xo), T) : mul(xo.ctm, T);
      patch(xo, `q ${mat(mul(target, inv))} cm ${nameToken(im.name)} Do Q`);
    } else {
      const original = model.streams[xo.stream].bytes.subarray(xo.start, xo.end);
      let raw = '';
      for (let i = 0; i < original.length; i++) raw += String.fromCharCode(original[i]);
      patch(xo, `q ${mat(mul(mul(xo.ctm, T), inv))} cm ${raw} Q`);
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

async function drawOverlays(bc: BuildCtx, page: PDFPage, overlays: Overlay[], under = '', over = '') {
  if (!overlays.length && !under && !over) return;
  const ctx = bc.doc.context;
  let out = over;
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
  // wrap existing content in q/Q so additions start from a clean graphics state
  const raw = page.node.get(PDFName.of('Contents'));
  const r = resolve(ctx, raw);
  const list: PDFObject[] = r instanceof PDFArray ? r.asArray() : raw ? [raw] : [];
  const parts: PDFObject[] = [];
  if (under) parts.push(ctx.register(ctx.flateStream(latin1(under))));
  if (list.length) {
    parts.push(ctx.register(ctx.flateStream(enc.encode('q\n'))), ...list, ctx.register(ctx.flateStream(enc.encode('\nQ\n'))));
  }
  if (out) parts.push(ctx.register(ctx.flateStream(latin1(out))));
  page.node.set(PDFName.of('Contents'), ctx.obj(parts));
}

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------
export function parsePageSpec(spec: string, total: number): Set<number> {
  const out = new Set<number>();
  if (!spec.trim()) {
    for (let i = 1; i <= total; i++) out.add(i);
    return out;
  }
  for (const part of spec.split(/[,;\s]+/)) {
    const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
    if (m) {
      const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : total;
      for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = +part;
      if (n >= 1 && n <= total) out.add(n);
    } else if (/^odd$/i.test(part)) for (let i = 1; i <= total; i += 2) out.add(i);
    else if (/^even$/i.test(part)) for (let i = 2; i <= total; i += 2) out.add(i);
  }
  return out;
}

async function drawWatermarks(bc: BuildCtx, page: PDFPage, wms: Watermark[]): Promise<{ under: string; over: string }> {
  let under = '', over = '';
  const ctx = bc.doc.context;
  const box = page.getCropBox();
  const { m, W, H } = uprightFrame({ x: box.x, y: box.y, w: box.width, h: box.height, rot: page.getRotation().angle });
  for (const wm of wms) {
    try {
      const a = (wm.angle * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      let w: number, h: number, draw: string;
      if (wm.kind === 'image' && wm.asset) {
        const im = await getImage(bc, page, wm.asset);
        if (!im) continue;
        w = W * (wm.imageScale ?? 0.5);
        h = (w * im.h) / im.w;
        draw = `${fmtNum(w)} 0 0 ${fmtNum(h)} ${fmtNum(-w / 2)} ${fmtNum(-h / 2)} cm ${nameToken(im.name)} Do`;
      } else {
        const lf = await getLibFont(bc, wm.font);
        const fk = page.node.newFontDictionary('EdWm', lf.ref).decodeText();
        const txt = libClean(lf, wm.text || ' ');
        w = lf.widthOfTextAtSize(txt, wm.size);
        h = lf.heightAtSize(wm.size, { descender: false }) * 0.72;
        draw = `BT ${nameToken(fk)} ${fmtNum(wm.size)} Tf ${rgbOps(wm.color)} 1 0 0 1 ${fmtNum(-w / 2)} ${fmtNum(-h / 2)} Tm ${lf.encodeText(txt).toString()} Tj ET`;
      }
      const ew = Math.abs(w * cos) + Math.abs(h * sin), eh = Math.abs(w * sin) + Math.abs(h * cos);
      const margin = Math.min(W, H) * 0.06;
      const centers: [number, number][] = [];
      const pos = wm.position;
      if (pos === 'tile') {
        const g = wm.gap ?? 1;
        const sx = (ew + Math.max(40, wm.size * 2)) * g, sy = (eh + Math.max(40, wm.size * 2)) * g;
        let row = 0;
        for (let y = sy / 2; y < H + sy; y += sy, row++) for (let x = (row % 2 ? sx / 2 : 0); x < W + sx; x += sx) centers.push([x, y]);
      } else {
        const cx = pos.includes('left') ? margin + ew / 2 : pos.includes('right') ? W - margin - ew / 2 : W / 2;
        const cy = pos.startsWith('top') ? margin + eh / 2 : pos.startsWith('bottom') ? H - margin - eh / 2 : H / 2;
        centers.push([cx, cy]);
      }
      const gsn = page.node.newExtGState('EdWmGS', ctx.register(ctx.obj({ Type: 'ExtGState', ca: wm.opacity, CA: wm.opacity }))).decodeText();
      let out = `/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q ${nameToken(gsn)} gs\n`;
      for (const [cx, cy] of centers) {
        const M = mul(mul([cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, cx, -cy]), m);
        out += `q ${mat(M)} cm ${draw} Q\n`;
      }
      out += 'Q EMC\n';
      if (wm.layer === 'under') under += out;
      else over += out;
    } catch (e) {
      console.warn('watermark skipped', e);
    }
  }
  return { under, over };
}

// ---------------------------------------------------------------------------
// Incremental (lossless) save: the original bytes are kept verbatim and only
// changed / new objects are appended in an update section.
// ---------------------------------------------------------------------------
function objBytes(o: PDFObject): Uint8Array {
  const b = new Uint8Array(o.sizeInBytes());
  o.copyBytesInto(b, 0);
  return b;
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Highest /Size declared by any trailer or xref stream in the file. */
function declaredSize(bytes: Uint8Array): number {
  const txt = new TextDecoder('latin1').decode(bytes.length > 4_000_000 ? bytes.subarray(bytes.length - 4_000_000) : bytes);
  let max = 0;
  for (const m of txt.matchAll(/\/Size\s+(\d+)/g)) max = Math.max(max, +m[1]);
  return max;
}

export async function saveIncremental(original: Uint8Array, built: PDFDocument): Promise<Uint8Array> {
  await built.flush();
  const orig = await PDFDocument.load(original, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  orig.getPages(); // normalise the same way the built document was
  const changed: [PDFRef, PDFObject][] = [];
  for (const [ref, obj] of built.context.enumerateIndirectObjects()) {
    const o = orig.context.lookup(ref);
    if (!o || !sameBytes(objBytes(o), objBytes(obj))) changed.push([ref, obj]);
  }
  if (!changed.length) return original;
  const tail = new TextDecoder('latin1').decode(original.subarray(Math.max(0, original.length - 2048)));
  const m = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(tail) ?? /startxref\s+(\d+)/.exec(tail);
  if (!m) throw new Error('no startxref');
  const prev = +m[1];
  const chunks: Uint8Array[] = [original];
  let offset = original.length;
  const push = (b: Uint8Array) => { chunks.push(b); offset += b.length; };
  if (original[original.length - 1] !== 0x0a) push(enc.encode('\n'));
  const offsets: { num: number; gen: number; off: number }[] = [];
  for (const [ref, obj] of changed) {
    offsets.push({ num: ref.objectNumber, gen: ref.generationNumber, off: offset });
    push(enc.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    push(objBytes(obj));
    push(enc.encode('\nendobj\n'));
  }
  const t = built.context.trailerInfo;
  const refStr = (r: unknown) => (r instanceof PDFRefClass ? `${r.objectNumber} ${r.generationNumber} R` : '');
  let common = `/Root ${refStr(t.Root)} /Prev ${prev}`;
  if (t.Info instanceof PDFRefClass) common += ` /Info ${refStr(t.Info)}`;
  if (t.ID) common += ` /ID ${new TextDecoder('latin1').decode(objBytes(t.ID))}`;
  const prevIsStream = /^\s*\d+\s+\d+\s+obj/.test(new TextDecoder('latin1').decode(original.subarray(prev, prev + 32)));
  let size = Math.max(built.context.largestObjectNumber, ...offsets.map((o) => o.num)) + 1;
  const xrefAt = offset;
  if (prevIsStream) {
    // the original uses a cross-reference stream: append one too (PDF 1.5+)
    const own = size++;
    offsets.push({ num: own, gen: 0, off: xrefAt });
    offsets.sort((a, b) => a.num - b.num);
    const index: number[] = [];
    const data: number[] = [];
    for (let i = 0; i < offsets.length; ) {
      let j = i;
      while (j + 1 < offsets.length && offsets[j + 1].num === offsets[j].num + 1) j++;
      index.push(offsets[i].num, j - i + 1);
      for (let k = i; k <= j; k++) {
        const { off, gen } = offsets[k];
        data.push(1, (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, (gen >> 8) & 255, gen & 255);
      }
      i = j + 1;
    }
    push(enc.encode(`${own} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Index [${index.join(' ')}] ${common} /Length ${data.length} >>\nstream\n`));
    push(Uint8Array.from(data));
    push(enc.encode(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  } else {
    offsets.sort((a, b) => a.num - b.num);
    let x = 'xref\n';
    for (let i = 0; i < offsets.length; ) {
      let j = i;
      while (j + 1 < offsets.length && offsets[j + 1].num === offsets[j].num + 1) j++;
      x += `${offsets[i].num} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) x += `${String(offsets[k].off).padStart(10, '0')} ${String(offsets[k].gen).padStart(5, '0')} n\r\n`;
      i = j + 1;
    }
    push(enc.encode(`${x}trailer\n<< /Size ${size} ${common} >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  }
  const out = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
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
  /** keep the original file bytes and append only the changes (lossless, signature-friendly) */
  incremental?: boolean;
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
      const bytes = sources.get(id)!.info.bytes;
      d = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
      d.registerFontkit(fontkit);
      // never reuse object numbers of the original file (xref streams / object streams aren't kept by pdf-lib)
      d.context.largestObjectNumber = Math.max(d.context.largestObjectNumber, declaredSize(bytes) - 1);
      fresh.set(id, d);
    }
    return d;
  };
  const primary = await load(primaryId);
  const ctxFor = new Map<PDFDocument, BuildCtx>();
  const bcOf = (doc: PDFDocument): BuildCtx => {
    let bc = ctxFor.get(doc);
    if (!bc) ctxFor.set(doc, (bc = { doc, stdFonts: new Map(), customFonts: new Map(), assets, images: new Map(), pool: [...sources.values()].find((x) => fresh.get(x.info.id) === doc)?.fonts.all() ?? [] }));
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

  // 4. overlays + watermarks (in the primary document context)
  const pbc = bcOf(primary);
  const wms = (state.watermarks ?? []).filter((w) => w.enabled);
  const wmPages = wms.map((w) => parsePageSpec(w.pages, state.pages.length));
  for (let i = 0; i < state.pages.length; i++) {
    const slot = state.pages[i];
    const page = pageObjs.get(slot.key)!;
    const ovs = (state.overlays[slot.key] ?? []).slice();
    const here = wms.filter((_, k) => wmPages[k].has(i + 1));
    if (!ovs.length && !here.length) continue;
    const { under, over } = here.length ? await drawWatermarks(pbc, page, here) : { under: '', over: '' };
    await drawOverlays(pbc, page, ovs.filter((o) => o.type !== 'redact').concat(ovs.filter((o) => o.type === 'redact')), under, over);
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

  if (opts.incremental && !sources.get(primaryId)!.encrypted) {
    try {
      if (Object.keys(state.forms).length && !state.flattenForms) primary.getForm().updateFieldAppearances();
      return await saveIncremental(sources.get(primaryId)!.info.bytes, primary);
    } catch (e) {
      console.warn('incremental save failed, rebuilding instead', e);
    }
  }
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
