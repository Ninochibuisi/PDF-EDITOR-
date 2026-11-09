/**
 * Font model: decodes shown bytes into glyphs (unicode + width) and – the
 * important part – re-encodes new text using the *original* embedded font so
 * that edited text keeps its exact typeface.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, type PDFContext, type PDFObject } from 'pdf-lib';
import { Encodings, Font as StdFont, type IFontNames } from '@pdf-lib/standard-fonts';
import { parseCMap, type CodespaceRange } from './cmap.ts';
import { parseFontProgram, type FontProgram } from './fontprog.ts';
import { arrNums, dictGet, getArray, getDict, getName, getNum, resolve, streamBytes } from './pdfobj.ts';

export interface Glyph {
  code: number;
  bytes: number[];
  unicode: string;
  /** advance width in 1/1000 text-space units */
  width: number;
  /** single-byte code 32: word spacing applies */
  isSpace: boolean;
}

export type TJItem = Uint8Array | number;

export interface EncodeResult {
  ok: boolean;
  items: TJItem[];
  missing: string[];
  /** advance in 1/1000 units (excl. Tc/Tw) */
  width: number;
  glyphs: Glyph[];
}

// ---------------------------------------------------------------------------
// Glyph-name -> unicode table, assembled from pdf-lib's bundled AFM data.
// ---------------------------------------------------------------------------
const GLYPH_TO_UNI = new Map<string, string>();
const UNI_TO_GLYPH = new Map<string, string>();
(() => {
  for (const enc of [Encodings.WinAnsi, Encodings.Symbol]) {
    const maps = (enc as unknown as { unicodeMappings: Record<string, [number, string]> }).unicodeMappings;
    for (const cp in maps) {
      const name = maps[cp][1];
      const ch = String.fromCodePoint(Number(cp));
      if (!GLYPH_TO_UNI.has(name)) GLYPH_TO_UNI.set(name, ch);
      if (enc === Encodings.WinAnsi && !UNI_TO_GLYPH.has(ch)) UNI_TO_GLYPH.set(ch, name);
    }
  }
  const extra: Record<string, string> = {
    fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ', dotlessi: 'ı', space: ' ', nbspace: ' ',
    hyphen: '-', minus: '−', endash: '–', emdash: '—', bullet: '•', quoteleft: '‘', quoteright: '’',
    quotedblleft: '“', quotedblright: '”', ellipsis: '…', Euro: '€', fraction: '⁄', lslash: 'ł', Lslash: 'Ł',
    oe: 'œ', OE: 'Œ', dotaccent: '˙', ring: '˚', ogonek: '˛', caron: 'ˇ', hungarumlaut: '˝', breve: '˘',
    macron: '¯', circumflex: 'ˆ', tilde: '˜', grave: '`', florin: 'ƒ', trademark: '™', perthousand: '‰',
    guilsinglleft: '‹', guilsinglright: '›', quotesinglbase: '‚', quotedblbase: '„', dagger: '†',
    daggerdbl: '‡', scaron: 'š', Scaron: 'Š', zcaron: 'ž', Zcaron: 'Ž', Ydieresis: 'Ÿ', copyright: '©',
    registered: '®', degree: '°', mu: 'µ', paragraph: '¶', section: '§', sterling: '£', yen: '¥',
    cent: '¢', currency: '¤', brokenbar: '¦', uni00A0: ' ', periodcentered: '·', middot: '·',
    arrowright: '→', arrowleft: '←', checkmark: '✓', 'f_f': 'ﬀ', 'f_i': 'ﬁ', 'f_l': 'ﬂ', 'f_f_i': 'ﬃ', 'f_f_l': 'ﬄ',
  };
  for (const k in extra) if (!GLYPH_TO_UNI.has(k)) GLYPH_TO_UNI.set(k, extra[k]);
})();

export function glyphNameToUnicode(name: string): string | undefined {
  const direct = GLYPH_TO_UNI.get(name);
  if (direct) return direct;
  const base = name.split('.')[0];
  if (base !== name && GLYPH_TO_UNI.has(base)) return GLYPH_TO_UNI.get(base);
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(base);
  if (m) {
    let s = '';
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  if (base.length === 1) return base;
  return undefined;
}

// ---------------------------------------------------------------------------
// Base encodings (code -> glyph name)
// ---------------------------------------------------------------------------
function decoderTable(label: string): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(256).fill(undefined);
  let dec: TextDecoder | undefined;
  try {
    dec = new TextDecoder(label);
  } catch {
    dec = undefined;
  }
  for (let i = 0; i < 256; i++) {
    if (i < 32) continue;
    const ch = dec ? dec.decode(Uint8Array.of(i)) : String.fromCharCode(i);
    if (ch === '\ufffd') continue;
    out[i] = UNI_TO_GLYPH.get(ch) ?? (ch.length === 1 ? 'uni' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') : undefined);
  }
  return out;
}

let WIN: (string | undefined)[] | undefined;
let MAC: (string | undefined)[] | undefined;
let STD: (string | undefined)[] | undefined;
function baseEncoding(name: string | undefined): (string | undefined)[] {
  if (name === 'MacRomanEncoding') return (MAC ??= decoderTable('macintosh'));
  if (name === 'WinAnsiEncoding' || name === 'PDFDocEncoding') return (WIN ??= decoderTable('windows-1252'));
  if (!STD) {
    STD = decoderTable('windows-1252').slice(0, 128);
    STD[0x27] = 'quoteright';
    STD[0x60] = 'quoteleft';
    const hi: Record<number, string> = {
      0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'fraction', 0xa5: 'yen', 0xa6: 'florin',
      0xa7: 'section', 0xa8: 'currency', 0xa9: 'quotesingle', 0xaa: 'quotedblleft', 0xab: 'guillemotleft',
      0xac: 'guilsinglleft', 0xad: 'guilsinglright', 0xae: 'fi', 0xaf: 'fl', 0xb1: 'endash', 0xb2: 'dagger',
      0xb3: 'daggerdbl', 0xb4: 'periodcentered', 0xb6: 'paragraph', 0xb7: 'bullet', 0xb8: 'quotesinglbase',
      0xb9: 'quotedblbase', 0xba: 'quotedblright', 0xbb: 'guillemotright', 0xbc: 'ellipsis', 0xbd: 'perthousand',
      0xbf: 'questiondown', 0xc1: 'grave', 0xc2: 'acute', 0xc3: 'circumflex', 0xc4: 'tilde', 0xc5: 'macron',
      0xc6: 'breve', 0xc7: 'dotaccent', 0xc8: 'dieresis', 0xca: 'ring', 0xcb: 'cedilla', 0xcd: 'hungarumlaut',
      0xce: 'ogonek', 0xcf: 'caron', 0xd0: 'emdash', 0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash',
      0xe9: 'Oslash', 0xea: 'OE', 0xeb: 'ordmasculine', 0xf1: 'ae', 0xf5: 'dotlessi', 0xf8: 'lslash',
      0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls',
    };
    for (let i = 128; i < 256; i++) STD[i] = hi[i];
  }
  return STD;
}

// ---------------------------------------------------------------------------
// Standard 14 metrics
// ---------------------------------------------------------------------------
const stdCache = new Map<string, StdFont>();
export function standardFontFor(baseFont: string, flags?: { bold?: boolean; italic?: boolean; serif?: boolean }): IFontNames | undefined {
  const n = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/[-,\s]/g, '').toLowerCase();
  const bold = /bold|black|heavy|semibold|demi/.test(n) || !!flags?.bold;
  const ital = /italic|oblique/.test(n) || !!flags?.italic;
  if (flags?.serif && !/sans|mono|courier/.test(n)) return (bold ? (ital ? 'Times-BoldItalic' : 'Times-Bold') : ital ? 'Times-Italic' : 'Times-Roman') as IFontNames;
  if (/symbol/.test(n)) return 'Symbol';
  if (/zapf|dingbat/.test(n)) return 'ZapfDingbats';
  if (/courier|mono|consol/.test(n)) return (bold ? (ital ? 'Courier-BoldOblique' : 'Courier-Bold') : ital ? 'Courier-Oblique' : 'Courier') as IFontNames;
  if (/times|serif|roman|georgia|garamond|cambria|minion|book|palatino/.test(n) && !/sans/.test(n))
    return (bold ? (ital ? 'Times-BoldItalic' : 'Times-Bold') : ital ? 'Times-Italic' : 'Times-Roman') as IFontNames;
  return (bold ? (ital ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : ital ? 'Helvetica-Oblique' : 'Helvetica') as IFontNames;
}
function stdMetrics(name: IFontNames): StdFont {
  let f = stdCache.get(name);
  if (!f) {
    f = StdFont.load(name);
    stdCache.set(name, f);
  }
  return f;
}

// ---------------------------------------------------------------------------
// PdfFont
// ---------------------------------------------------------------------------
export class PdfFont {
  baseFont = '';
  subtype = '';
  isType0 = false;
  isType3 = false;
  isSubset = false;
  embedded = false;
  /** glyph-space -> 1/1000 em (1 for normal fonts, FontMatrix[0]*1000 for Type3) */
  widthScale = 1;
  ascent = 800;
  descent = -200;
  bold = false;
  italic = false;
  serif = false;
  /** whether unicode comes from a ToUnicode map (reliable) */
  hasToUnicode = false;
  /** codes actually used in content we interpreted */
  usedCodes = new Set<number>();
  /** indirect reference of the font dictionary (lets other pages borrow its glyphs) */
  ref?: PDFRef;
  /** parsed embedded font program, when readable */
  program?: FontProgram;
  symbolic = false;
  private codeNames: (string | undefined)[] = [];
  /** Type3: glyph procedures that exist in /CharProcs */
  private charProcs?: Set<string>;
  private tuCodes = new Set<number>();
  private gidToUni?: Map<number, string>;

  private codespace: CodespaceRange[] = [{ len: 1, lo: 0, hi: 255 }];
  private toUni = new Map<number, string>();
  private toCid?: Map<number, number>;
  private codeLenHint = new Map<number, number>();
  private widths = new Map<number, number>(); // keyed by code (simple) or CID (type0)
  private defaultWidth = 0;
  private cidToGid?: Uint16Array;
  private reverse?: Map<string, number>;
  private maxLig = 1;

  constructor(ctx: PDFContext, dict: PDFDict) {
    this.subtype = getName(ctx, dict, 'Subtype') ?? 'Type1';
    this.baseFont = getName(ctx, dict, 'BaseFont') ?? getName(ctx, dict, 'Name') ?? 'Unknown';
    this.isSubset = /^[A-Z]{6}\+/.test(this.baseFont);
    this.isType0 = this.subtype === 'Type0';
    this.isType3 = this.subtype === 'Type3';

    let descriptor: PDFDict | undefined;
    if (this.isType0) {
      const desc = getArray(ctx, dict, 'DescendantFonts');
      const cid = desc ? (resolve(ctx, desc.get(0)) as PDFDict | undefined) : undefined;
      if (cid instanceof PDFDict) {
        descriptor = getDict(ctx, cid, 'FontDescriptor');
        this.loadCidWidths(ctx, cid);
        const cidSub = getName(ctx, cid, 'Subtype');
        const ff2 = descriptor ? dictGet(ctx, descriptor, 'FontFile2') : undefined;
        if (cidSub === 'CIDFontType2' && ff2) {
          const c2g = dictGet(ctx, cid, 'CIDToGIDMap');
          if (c2g && !(c2g instanceof PDFName)) {
            const m = streamBytes(ctx, c2g);
            if (m) {
              this.cidToGid = new Uint16Array(m.length >> 1);
              for (let i = 0; i < this.cidToGid.length; i++) this.cidToGid[i] = (m[i * 2] << 8) | m[i * 2 + 1];
            }
          }
        }
      }
      const enc = dictGet(ctx, dict, 'Encoding');
      this.codespace = [{ len: 2, lo: 0, hi: 0xffff }];
      if (enc && !(enc instanceof PDFName)) {
        const data = streamBytes(ctx, enc);
        if (data) {
          const cm = parseCMap(data);
          if (cm.codespace.length) this.codespace = cm.codespace;
          if (cm.toCid.size) this.toCid = cm.toCid;
        }
      }
    } else {
      descriptor = getDict(ctx, dict, 'FontDescriptor');
      this.loadSimple(ctx, dict);
    }

    if (descriptor) {
      if (this.baseFont === 'Unknown') {
        const fn = getName(ctx, descriptor, 'FontName');
        if (fn) {
          this.baseFont = fn;
          this.isSubset = /^[A-Z]{6}\+/.test(fn);
        }
      }
      const asc = getNum(ctx, descriptor, 'Ascent');
      const dsc = getNum(ctx, descriptor, 'Descent');
      if (asc && asc > 0) this.ascent = asc;
      if (dsc && dsc < 0) this.descent = dsc;
      const flags = getNum(ctx, descriptor, 'Flags') ?? 0;
      this.serif = (flags & 2) !== 0;
      this.italic = (flags & 64) !== 0 || (getNum(ctx, descriptor, 'ItalicAngle') ?? 0) !== 0;
      const fw = getNum(ctx, descriptor, 'FontWeight');
      this.bold = (flags & (1 << 18)) !== 0 || (fw !== undefined && fw >= 600);
      this.embedded = !!(dictGet(ctx, descriptor, 'FontFile') || dictGet(ctx, descriptor, 'FontFile2') || dictGet(ctx, descriptor, 'FontFile3'));
      if (!this.defaultWidth) this.defaultWidth = getNum(ctx, descriptor, 'MissingWidth') ?? 0;
    }
    if (descriptor) {
      this.symbolic = ((getNum(ctx, descriptor, 'Flags') ?? 0) & 4) !== 0;
      for (const k of ['FontFile2', 'FontFile3', 'FontFile'] as const) {
        const ff = dictGet(ctx, descriptor, k);
        if (!ff) continue;
        const data = streamBytes(ctx, ff);
        if (data) this.program = parseFontProgram(data, k);
        break;
      }
    }
    if (this.isType3) {
      this.embedded = true;
      this.ascent = 800;
      this.descent = -200;
    }
    const n = this.baseFont.toLowerCase();
    if (/bold|black|heavy|semibold/.test(n)) this.bold = true;
    if (/italic|oblique/.test(n)) this.italic = true;

    // ToUnicode overrides everything
    const tu = dictGet(ctx, dict, 'ToUnicode');
    if (tu && !(tu instanceof PDFName)) {
      const data = streamBytes(ctx, tu);
      if (data) {
        const cm = parseCMap(data);
        if (cm.toUnicode.size) {
          this.hasToUnicode = true;
          for (const [k, v] of cm.toUnicode) { this.toUni.set(k, v); this.tuCodes.add(k); }
          for (const [k, v] of cm.codeLen) this.codeLenHint.set(k, v);
          if (this.isType0 && this.codespace.length === 1 && this.codespace[0].len === 2 && cm.codespace.length) {
            // honour ToUnicode codespace when the encoding is a predefined CMap we don't ship
            const enc = getName(ctx, dict, 'Encoding');
            if (enc && !/^Identity-[HV]$/.test(enc)) this.codespace = cm.codespace;
          }
        }
      }
    }
  }

  private loadCidWidths(ctx: PDFContext, cid: PDFDict) {
    this.defaultWidth = getNum(ctx, cid, 'DW') ?? 1000;
    const w = getArray(ctx, cid, 'W');
    if (!w) return;
    const items: PDFObject[] = [];
    for (let i = 0; i < w.size(); i++) items.push(resolve(ctx, w.get(i))!);
    for (let i = 0; i < items.length; ) {
      const first = items[i];
      const second = items[i + 1];
      if (!(first instanceof PDFNumber)) break;
      const c0 = first.asNumber();
      if (second instanceof PDFArray) {
        const ws = arrNums(ctx, second);
        ws.forEach((v, k) => this.widths.set(c0 + k, v));
        i += 2;
      } else if (second instanceof PDFNumber && items[i + 2] instanceof PDFNumber) {
        const c1 = second.asNumber();
        const v = (items[i + 2] as PDFNumber).asNumber();
        for (let c = c0; c <= c1 && c - c0 < 65536; c++) this.widths.set(c, v);
        i += 3;
      } else break;
    }
  }

  private loadSimple(ctx: PDFContext, dict: PDFDict) {
    if (this.isType3) {
      const fm = arrNums(ctx, getArray(ctx, dict, 'FontMatrix'));
      this.widthScale = (fm[0] || 0.001) * 1000;
      const cp = getDict(ctx, dict, 'CharProcs');
      if (cp) this.charProcs = new Set(cp.keys().map((k) => k.decodeText()));
    }
    const first = getNum(ctx, dict, 'FirstChar') ?? 0;
    const ws = getArray(ctx, dict, 'Widths');
    if (ws) arrNums(ctx, ws).forEach((v, i) => this.widths.set(first + i, v * this.widthScale));

    // encoding -> glyph names -> unicode
    const encObj = dictGet(ctx, dict, 'Encoding');
    let baseName: string | undefined;
    let diffs: PDFArray | undefined;
    if (encObj instanceof PDFName) baseName = encObj.decodeText();
    else if (encObj instanceof PDFDict) {
      baseName = getName(ctx, encObj, 'BaseEncoding');
      diffs = getArray(ctx, encObj, 'Differences');
    }
    const std = standardFontFor(this.baseFont);
    const isSymbolic = std === 'Symbol' || std === 'ZapfDingbats';
    const names: (string | undefined)[] = isSymbolic && !baseName ? new Array(256).fill(undefined) : baseEncoding(baseName).slice();
    if (isSymbolic && !baseName && std) {
      const m = stdMetrics(std);
      for (const cm of (m as unknown as { CharMetrics: { C: number; N: string }[] }).CharMetrics) if (cm.C >= 0) names[cm.C] = cm.N;
    }
    if (diffs) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const v = resolve(ctx, diffs.get(i));
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) names[code++] = v.decodeText();
      }
    }
    this.codeNames = names;
    const stdName = !ws && std ? std : undefined;
    const metrics = stdName ? stdMetrics(stdName) : undefined;
    for (let c = 0; c < 256; c++) {
      const gn = names[c];
      if (!gn) continue;
      const u = glyphNameToUnicode(gn);
      if (u !== undefined) this.toUni.set(c, u);
      if (metrics && !this.widths.has(c)) {
        const w = metrics.getWidthOfGlyph(gn);
        if (w !== undefined) this.widths.set(c, w);
      }
    }
    if (!ws && !metrics) this.defaultWidth = 500;
  }

  get displayName(): string {
    return this.baseFont.replace(/^[A-Z]{6}\+/, '');
  }

  private codeLength(bytes: Uint8Array, i: number): number {
    if (this.codespace.length === 1) return this.codespace[0].len;
    let v = 0;
    for (let len = 1; len <= 4 && i + len <= bytes.length; len++) {
      v = v * 256 + bytes[i + len - 1];
      for (const r of this.codespace) if (r.len === len && v >= r.lo && v <= r.hi) return len;
    }
    // fall back to the most common length
    return this.codespace[0].len;
  }

  private cidOf(code: number): number {
    return this.toCid?.get(code) ?? code;
  }

  widthOfCode(code: number): number {
    const key = this.isType0 ? this.cidOf(code) : code;
    const w = this.widths.get(key);
    return w !== undefined ? w : this.defaultWidth;
  }

  decode(bytes: Uint8Array): Glyph[] {
    const out: Glyph[] = [];
    for (let i = 0; i < bytes.length; ) {
      const len = Math.min(this.codeLength(bytes, i), bytes.length - i);
      let code = 0;
      const raw: number[] = [];
      for (let k = 0; k < len; k++) {
        code = code * 256 + bytes[i + k];
        raw.push(bytes[i + k]);
      }
      i += len;
      this.usedCodes.add(code);
      let u = this.toUni.get(code);
      if (u === undefined && this.isType0) u = this.uniFromProgram(code);
      if (u === undefined) {
        if (!this.isType0 && code >= 32 && code < 127 && !this.hasToUnicode) u = String.fromCharCode(code);
        else u = '\ufffd';
      }
      out.push({ code, bytes: raw, unicode: u, width: this.widthOfCode(code), isSpace: len === 1 && code === 32 });
    }
    return out;
  }

  private gidOfCid(cid: number): number {
    return this.cidToGid ? this.cidToGid[cid] ?? 0 : cid;
  }

  private uniFromProgram(code: number): string | undefined {
    const P = this.program;
    if (!P?.unicodeCmap) return undefined;
    if (!this.gidToUni) {
      this.gidToUni = new Map();
      for (const [u, g] of P.unicodeCmap) if (!this.gidToUni.has(g)) this.gidToUni.set(g, String.fromCodePoint(u));
    }
    return this.gidToUni.get(this.gidOfCid(this.cidOf(code)));
  }

  /** Does the embedded font program really contain a glyph for this code? undefined = can't tell. */
  private programHas(code: number): boolean | undefined {
    const P = this.program;
    if (!P) return undefined;
    if (this.isType0) {
      const cid = this.cidOf(code);
      let gid: number | undefined;
      if (P.cidToGid) gid = P.cidToGid.get(cid);
      else gid = this.gidOfCid(cid);
      if (gid === undefined) return false;
      return P.hasGlyph(gid) || (gid > 0 && /^\s$/.test(this.toUni.get(code) ?? ''));
    }
    const name = this.codeNames[code];
    if (P.kind === 'type1' || P.kind === 'cff') {
      if (!name) return P.kind === 'cff' ? undefined : false;
      const g = P.nameToGid?.get(name);
      if (g === undefined) return false;
      return P.hasGlyph(g) || /space/.test(name);
    }
    let gid: number | undefined;
    if (P.codeCmap && (this.symbolic || !P.unicodeCmap)) gid = P.codeCmap.get(0xf000 + code) ?? P.codeCmap.get(code);
    if (gid === undefined && P.unicodeCmap && name) {
      const u = glyphNameToUnicode(name);
      if (u) gid = P.unicodeCmap.get(u.codePointAt(0)!);
    }
    if (gid === undefined && name && P.nameToGid) gid = P.nameToGid.get(name);
    if (gid === undefined && P.codeCmap) gid = P.codeCmap.get(code) ?? P.codeCmap.get(0xf000 + code);
    if (!gid) return false;
    return P.hasGlyph(gid) || name === 'space' || code === 32;
  }

  private codeAvailable(code: number): boolean {
    if (this.usedCodes.has(code)) return true;
    const p = this.programHas(code);
    if (p !== undefined) return p;
    if (this.isType3) {
      // Type3: a glyph exists when its procedure is in /CharProcs
      const n = this.codeNames[code];
      return !!(n && this.charProcs?.has(n));
    }
    if (!this.embedded) return true; // viewer-provided font has all glyphs
    if (this.isSubset) return this.tuCodes.has(code) && this.widths.has(this.isType0 ? this.cidOf(code) : code);
    return true;
  }

  private buildReverse() {
    const rev = new Map<string, number>();
    // used codes first (most reliable), then everything else that maps
    const consider = (code: number, u: string) => {
      if (!u || u === '\ufffd') return;
      const nu = u.normalize('NFC');
      if (!rev.has(nu) && this.codeAvailable(code)) rev.set(nu, code);
      if (nu.length > this.maxLig) this.maxLig = Math.min(nu.length, 4);
    };
    for (const code of this.usedCodes) {
      const u = this.toUni.get(code) ?? (this.isType0 ? this.uniFromProgram(code) : code >= 32 && code < 127 ? String.fromCharCode(code) : undefined);
      if (u) consider(code, u);
    }
    for (const [code, u] of this.toUni) consider(code, u);
    if (!this.isType0 && !this.hasToUnicode) {
      for (let c = 32; c < 127; c++) if (!this.toUni.has(c)) consider(c, String.fromCharCode(c));
    }
    // Identity-encoded TrueType: any glyph in the embedded program is reachable through its cmap
    const P = this.program;
    if (this.isType0 && !this.toCid && P?.unicodeCmap && this.codespace.length === 1 && this.codespace[0].len === 2) {
      let inv: Map<number, number> | undefined;
      if (this.cidToGid) {
        inv = new Map();
        this.cidToGid.forEach((g, cid) => { if (g && !inv!.has(g)) inv!.set(g, cid); });
      }
      for (const [u, gid] of P.unicodeCmap) {
        const ch = String.fromCodePoint(u).normalize('NFC');
        if (rev.has(ch)) continue;
        const cid = inv ? inv.get(gid) : gid;
        if (cid === undefined || cid > 0xffff) continue;
        if (P.hasGlyph(gid) || /^\s$/.test(ch)) rev.set(ch, cid);
      }
    }
    this.reverse = rev;
  }

  /** Invalidate the reverse map (after more content was interpreted). */
  touch() {
    this.reverse = undefined;
  }

  canEncodeChar(ch: string): boolean {
    if (!this.reverse) this.buildReverse();
    return this.reverse!.has(ch);
  }

  /**
   * Encode unicode text in this font. Spaces the font lacks are emulated with
   * TJ kerning (as TeX does), so text stays in the original font.
   */
  encode(text: string): EncodeResult {
    if (!this.reverse) this.buildReverse();
    const rev = this.reverse!;
    const items: TJItem[] = [];
    const glyphs: Glyph[] = [];
    const missing: string[] = [];
    let cur: number[] = [];
    let width = 0;
    const flush = () => {
      if (cur.length) items.push(Uint8Array.from(cur));
      cur = [];
    };
    const chars = Array.from(text.normalize('NFC'));
    const spaceW = this.spaceWidth();
    for (let i = 0; i < chars.length; ) {
      let matched = false;
      for (let L = Math.min(this.maxLig, chars.length - i); L >= 1; L--) {
        const s = chars.slice(i, i + L).join('');
        const code = rev.get(s);
        if (code === undefined) continue;
        const len = this.encodedLength(code);
        const bytes: number[] = [];
        for (let k = len - 1; k >= 0; k--) bytes.push((code >> (8 * k)) & 0xff);
        cur.push(...bytes);
        const w = this.widthOfCode(code);
        width += w;
        glyphs.push({ code, bytes, unicode: s, width: w, isSpace: len === 1 && code === 32 });
        i += L;
        matched = true;
        break;
      }
      if (matched) continue;
      const ch = chars[i];
      if (ch === ' ' || ch === ' ' || ch === '\t') {
        flush();
        const w = ch === '\t' ? spaceW * 4 : spaceW;
        items.push(-w);
        width += w;
        glyphs.push({ code: -1, bytes: [], unicode: ' ', width: w, isSpace: false });
      } else {
        missing.push(ch);
      }
      i++;
    }
    flush();
    return { ok: missing.length === 0, items, missing, width, glyphs };
  }

  /** Longest glyph match at position i (ligatures first). */
  matchAt(chars: string[], i: number): { glyph: Glyph; len: number } | null {
    if (!this.reverse) this.buildReverse();
    for (let L = Math.min(this.maxLig, chars.length - i); L >= 1; L--) {
      const s = chars.slice(i, i + L).join('');
      const code = this.reverse!.get(s);
      if (code === undefined) continue;
      const len = this.encodedLength(code);
      const bytes: number[] = [];
      for (let k = len - 1; k >= 0; k--) bytes.push((code >> (8 * k)) & 0xff);
      return { glyph: { code, bytes, unicode: s, width: this.widthOfCode(code), isSpace: len === 1 && code === 32 }, len: L };
    }
    return null;
  }

  private encodedLength(code: number): number {
    const hint = this.codeLenHint.get(code);
    if (this.codespace.length === 1) return this.codespace[0].len;
    if (hint) return hint;
    for (const r of this.codespace) if (code >= r.lo && code <= r.hi) return r.len;
    return this.codespace[0].len;
  }

  spaceWidth(): number {
    if (!this.reverse) this.buildReverse();
    const sp = this.reverse!.get(' ');
    if (sp !== undefined) return this.widthOfCode(sp) || 250;
    return 250;
  }
}

/** Cache of fonts per object reference. */
export class FontCache {
  private byRef = new Map<string, PdfFont>();
  private ctx: PDFContext;
  constructor(ctx: PDFContext) {
    this.ctx = ctx;
  }
  get(obj: PDFObject | undefined): PdfFont | undefined {
    const key = obj instanceof PDFRef ? obj.toString() : undefined;
    if (key && this.byRef.has(key)) return this.byRef.get(key);
    const d = resolve(this.ctx, obj);
    if (!(d instanceof PDFDict)) return undefined;
    let f: PdfFont;
    try {
      f = new PdfFont(this.ctx, d);
    } catch (e) {
      console.warn('font parse failed', e);
      return undefined;
    }
    if (obj instanceof PDFRef) f.ref = obj;
    if (key) this.byRef.set(key, f);
    return f;
  }
  /** every font parsed so far in this document */
  all(): PdfFont[] {
    return [...this.byRef.values()];
  }
}

export interface Segment {
  /** index into the font list */
  fi: number;
  items: TJItem[];
  glyphs: Glyph[];
}
export interface MultiEncode {
  ok: boolean;
  missing: string[];
  segs: Segment[];
}

/**
 * Encode text across several fonts of the same family (PDF producers often
 * split one typeface into multiple subsets). Prefers staying in the current
 * font to minimise font switches; spaces the fonts lack become kerning.
 */
export function encodeMulti(fonts: PdfFont[], text: string): MultiEncode {
  const chars = Array.from(text.normalize('NFC'));
  const segs: Segment[] = [];
  const missing: string[] = [];
  let cur = 0;
  let seg: Segment | undefined;
  let bytes: number[] = [];
  const flush = () => {
    if (seg && bytes.length) seg.items.push(Uint8Array.from(bytes));
    bytes = [];
  };
  const segFor = (fi: number) => {
    if (!seg || seg.fi !== fi) {
      flush();
      seg = { fi, items: [], glyphs: [] };
      segs.push(seg);
      cur = fi;
    }
    return seg;
  };
  for (let i = 0; i < chars.length; ) {
    let hit = fonts[cur].matchAt(chars, i);
    let fi = cur;
    if (!hit) {
      for (let k = 0; k < fonts.length && !hit; k++) {
        if (k === cur) continue;
        hit = fonts[k].matchAt(chars, i);
        if (hit) fi = k;
      }
    }
    if (hit) {
      const sg = segFor(fi);
      bytes.push(...hit.glyph.bytes);
      sg.glyphs.push(hit.glyph);
      i += hit.len;
      continue;
    }
    const ch = chars[i];
    if (ch === ' ' || ch === '\u00a0' || ch === '\t') {
      const sg = segFor(cur);
      flush();
      const w = fonts[cur].spaceWidth() * (ch === '\t' ? 4 : 1);
      sg.items.push(-w);
      sg.glyphs.push({ code: -1, bytes: [], unicode: ' ', width: w, isSpace: false });
    } else missing.push(ch);
    i++;
  }
  flush();
  return { ok: missing.length === 0, missing, segs };
}
