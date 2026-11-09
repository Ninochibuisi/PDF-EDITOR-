/**
 * Embedded font program inspection (TrueType/OpenType, CFF, Type 1).
 *
 * Tells the engine which glyphs physically exist in an embedded (often
 * subset) font and how Unicode maps to them – so new text is only ever drawn
 * with glyphs that are really there, and characters already in the font
 * (₦, $, €, ligatures…) can be typed without changing the typeface.
 */
import { CFF_STANDARD_STRINGS } from './cffstd.ts';

export interface FontProgram {
  kind: 'truetype' | 'cff' | 'type1';
  numGlyphs: number;
  /** glyph id has an outline (or is a known blank glyph like space) */
  hasGlyph(gid: number): boolean;
  /** glyph names present (Type 1, CFF, TrueType post table) */
  nameToGid?: Map<string, number>;
  /** CID-keyed CFF: CIDs present → gid */
  cidToGid?: Map<number, number>;
  /** unicode → gid from a Unicode cmap */
  unicodeCmap?: Map<number, number>;
  /** symbol / Mac Roman cmap: code (or 0xF000+code) → gid */
  codeCmap?: Map<number, number>;
}

// ---------------------------------------------------------------------------
// TrueType / OpenType
// ---------------------------------------------------------------------------
function parseSfnt(data: Uint8Array): FontProgram | undefined {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag0 = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (tag0 === 'ttcf') return undefined;
  const numTables = dv.getUint16(4);
  const t: Record<string, { off: number; len: number }> = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (o + 16 > data.length) break;
    t[String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3])] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
  }
  const numGlyphs = t.maxp ? dv.getUint16(t.maxp.off + 4) : 0;
  let hasGlyph: (gid: number) => boolean = (gid) => gid > 0 && gid < numGlyphs;
  if (t.loca && t.head && t.glyf) {
    const longFmt = dv.getInt16(t.head.off + 50) === 1;
    const lo = t.loca.off;
    const off = (g: number) => (longFmt ? dv.getUint32(lo + g * 4) : dv.getUint16(lo + g * 2) * 2);
    hasGlyph = (gid) => gid > 0 && gid < numGlyphs && off(gid + 1) > off(gid);
  } else if (t['CFF ']) {
    const cff = parseCff(data.subarray(t['CFF '].off, t['CFF '].off + t['CFF '].len));
    if (cff) hasGlyph = cff.hasGlyph;
  }
  const prog: FontProgram = { kind: 'truetype', numGlyphs, hasGlyph };
  // cmap
  if (t.cmap) {
    const base = t.cmap.off;
    const n = dv.getUint16(base + 2);
    const subs: { pid: number; eid: number; off: number }[] = [];
    for (let i = 0; i < n; i++) subs.push({ pid: dv.getUint16(base + 4 + i * 8), eid: dv.getUint16(base + 6 + i * 8), off: base + dv.getUint32(base + 8 + i * 8) });
    const read = (off: number): Map<number, number> => {
      const m = new Map<number, number>();
      const fmt = dv.getUint16(off);
      if (fmt === 0) for (let c = 0; c < 256; c++) { const g = data[off + 6 + c]; if (g) m.set(c, g); }
      else if (fmt === 4) {
        const segX2 = dv.getUint16(off + 6);
        const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let s = 0; s < segX2 / 2; s++) {
          const end = dv.getUint16(ends + s * 2), start = dv.getUint16(starts + s * 2);
          const delta = dv.getInt16(deltas + s * 2), ro = dv.getUint16(ranges + s * 2);
          if (start === 0xffff) continue;
          for (let c = start; c <= end && c - start < 0x10000; c++) {
            let g: number;
            if (ro === 0) g = (c + delta) & 0xffff;
            else {
              const gi = ranges + s * 2 + ro + (c - start) * 2;
              if (gi + 2 > data.length) break;
              g = dv.getUint16(gi);
              if (g) g = (g + delta) & 0xffff;
            }
            if (g) m.set(c, g);
          }
        }
      } else if (fmt === 6) {
        const first = dv.getUint16(off + 6), cnt = dv.getUint16(off + 8);
        for (let i = 0; i < cnt; i++) { const g = dv.getUint16(off + 10 + i * 2); if (g) m.set(first + i, g); }
      } else if (fmt === 12) {
        const groups = dv.getUint32(off + 12);
        for (let i = 0; i < groups; i++) {
          const o = off + 16 + i * 12;
          const sc = dv.getUint32(o), ec = dv.getUint32(o + 4), sg = dv.getUint32(o + 8);
          for (let c = sc; c <= ec && c - sc < 0x10000; c++) m.set(c, sg + c - sc);
        }
      }
      return m;
    };
    try {
      const uni = subs.find((x) => x.pid === 3 && x.eid === 10) ?? subs.find((x) => x.pid === 3 && x.eid === 1) ?? subs.find((x) => x.pid === 0);
      if (uni) prog.unicodeCmap = read(uni.off);
      const sym = subs.find((x) => x.pid === 3 && x.eid === 0) ?? subs.find((x) => x.pid === 1 && x.eid === 0);
      if (sym) prog.codeCmap = read(sym.off);
    } catch { /* malformed cmap */ }
  }
  // post table glyph names (format 2)
  if (t.post) {
    try {
      const p = t.post.off;
      if (dv.getUint32(p) === 0x00020000) {
        const n = dv.getUint16(p + 32);
        const idx: number[] = [];
        for (let i = 0; i < n; i++) idx.push(dv.getUint16(p + 34 + i * 2));
        const names: string[] = [];
        let q = p + 34 + n * 2;
        while (q < p + t.post.len) {
          const len = data[q];
          names.push(String.fromCharCode(...data.subarray(q + 1, q + 1 + len)));
          q += 1 + len;
        }
        const m = new Map<string, number>();
        idx.forEach((v, gid) => {
          const nm = v < 258 ? MAC_GLYPHS[v] : names[v - 258];
          if (nm && !m.has(nm)) m.set(nm, gid);
        });
        prog.nameToGid = m;
      }
    } catch { /* ignore */ }
  }
  return prog;
}

// ---------------------------------------------------------------------------
// CFF (bare FontFile3 / Type1C / CIDFontType0C, or inside OpenType)
// ---------------------------------------------------------------------------
function readIndex(d: Uint8Array, pos: number): { items: [number, number][]; end: number } {
  const count = (d[pos] << 8) | d[pos + 1];
  if (count === 0) return { items: [], end: pos + 2 };
  const offSize = d[pos + 2];
  const offAt = (i: number) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = (v << 8) | d[pos + 3 + i * offSize + k];
    return v >>> 0;
  };
  const dataStart = pos + 3 + (count + 1) * offSize - 1;
  const items: [number, number][] = [];
  for (let i = 0; i < count; i++) items.push([dataStart + offAt(i), dataStart + offAt(i + 1)]);
  return { items, end: dataStart + offAt(count) };
}

function parseDict(d: Uint8Array, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let ops: number[] = [];
  for (let i = start; i < end; ) {
    const b = d[i];
    if (b <= 21) {
      let op = b;
      i++;
      if (b === 12) op = 1200 + d[i++];
      out.set(op, ops);
      ops = [];
    } else if (b === 28) { ops.push(((d[i + 1] << 24) >> 16) | d[i + 2]); i += 3; }
    else if (b === 29) { ops.push((d[i + 1] << 24) | (d[i + 2] << 16) | (d[i + 3] << 8) | d[i + 4]); i += 5; }
    else if (b === 30) {
      i++;
      let s = '';
      for (;;) {
        const x = d[i++];
        const n1 = x >> 4, n2 = x & 15;
        const nib = (n: number) => (n < 10 ? String(n) : n === 10 ? '.' : n === 11 ? 'E' : n === 12 ? 'E-' : n === 14 ? '-' : '');
        if (n1 === 15) break;
        s += nib(n1);
        if (n2 === 15) break;
        s += nib(n2);
      }
      ops.push(parseFloat(s) || 0);
    } else if (b >= 32 && b <= 246) { ops.push(b - 139); i++; }
    else if (b >= 247 && b <= 250) { ops.push((b - 247) * 256 + d[i + 1] + 108); i += 2; }
    else if (b >= 251 && b <= 254) { ops.push(-(b - 251) * 256 - d[i + 1] - 108); i += 2; }
    else i++;
  }
  return out;
}

function parseCff(d: Uint8Array): FontProgram | undefined {
  try {
    const hdr = d[2];
    const names = readIndex(d, hdr);
    const top = readIndex(d, names.end);
    const strings = readIndex(d, top.end);
    if (!top.items.length) return undefined;
    const dict = parseDict(d, top.items[0][0], top.items[0][1]);
    const csOff = dict.get(17)?.[0];
    if (csOff === undefined) return undefined;
    const cs = readIndex(d, csOff);
    const numGlyphs = cs.items.length;
    const lens = cs.items.map(([a, b]) => b - a);
    const cidKeyed = dict.has(1230);
    const sid = (s: number) => (s < 391 ? CFF_STANDARD_STRINGS[s] : (() => { const it = strings.items[s - 391]; return it ? String.fromCharCode(...d.subarray(it[0], it[1])) : ''; })());
    // charset: gid -> SID / CID
    const ids: number[] = [0];
    const csetOff = dict.get(15)?.[0] ?? 0;
    if (csetOff > 2) {
      const fmt = d[csetOff];
      let p = csetOff + 1;
      if (fmt === 0) for (let g = 1; g < numGlyphs; g++, p += 2) ids.push((d[p] << 8) | d[p + 1]);
      else {
        while (ids.length < numGlyphs) {
          const first = (d[p] << 8) | d[p + 1];
          const left = fmt === 1 ? d[p + 2] : (d[p + 2] << 8) | d[p + 3];
          p += fmt === 1 ? 3 : 4;
          for (let k = 0; k <= left && ids.length < numGlyphs; k++) ids.push(first + k);
        }
      }
    } else for (let g = 1; g < numGlyphs; g++) ids.push(g); // ISOAdobe: SID = gid
    const blankOk = new Set(['space', 'nbspace', 'uni00A0', 'nonbreakingspace']);
    const prog: FontProgram = { kind: 'cff', numGlyphs, hasGlyph: () => false };
    if (cidKeyed) {
      prog.cidToGid = new Map(ids.map((cid, gid) => [cid, gid]));
      prog.hasGlyph = (gid) => gid > 0 && gid < numGlyphs && lens[gid] > 1;
    } else {
      const n2g = new Map<string, number>();
      ids.forEach((s, gid) => { if (gid) n2g.set(sid(s), gid); });
      prog.nameToGid = n2g;
      prog.hasGlyph = (gid) => gid > 0 && gid < numGlyphs && (lens[gid] > 4 || blankOk.has(sid(ids[gid])));
    }
    return prog;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Type 1 (eexec-encrypted CharStrings)
// ---------------------------------------------------------------------------
function parseType1(data: Uint8Array): FontProgram | undefined {
  const txt = new TextDecoder('latin1').decode(data);
  const at = txt.indexOf('eexec');
  if (at < 0) return undefined;
  let p = at + 5;
  while (p < data.length && (data[p] === 0x0d || data[p] === 0x0a || data[p] === 0x20 || data[p] === 0x09)) p++;
  let enc = data.subarray(p);
  // hex form?
  if (/^[0-9a-fA-F]{4}/.test(txt.slice(p, p + 4))) {
    const hex = txt.slice(p).replace(/[^0-9a-fA-F]/g, '');
    const b = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
    enc = b;
  }
  let r = 55665;
  const plain = new Uint8Array(enc.length);
  for (let i = 0; i < enc.length; i++) {
    const c = enc[i];
    plain[i] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  const s = new TextDecoder('latin1').decode(plain.subarray(4));
  const csAt = s.indexOf('/CharStrings');
  if (csAt < 0) return undefined;
  const names = new Map<string, number>();
  const re = /\/([^\s/[\]{}()<>]+)\s+(\d+)\s+(RD|-\|)\s/g;
  re.lastIndex = csAt + 12;
  let gid = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    names.set(m[1], gid++);
    re.lastIndex = m.index + m[0].length + Number(m[2]);
    if (gid > 5000) break;
  }
  return { kind: 'type1', numGlyphs: gid, hasGlyph: (g) => g >= 0 && g < gid, nameToGid: names };
}

export function parseFontProgram(data: Uint8Array, key: 'FontFile' | 'FontFile2' | 'FontFile3'): FontProgram | undefined {
  try {
    if (data.length < 16) return undefined;
    const tag = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (tag === 'OTTO' || tag === 'true' || (data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0)) return parseSfnt(data);
    if (key === 'FontFile') return parseType1(data);
    if (key === 'FontFile3' && data[0] === 1) return parseCff(data);
    if (key === 'FontFile2') return parseSfnt(data);
  } catch {
    /* unreadable program – fall back to heuristics */
  }
  return undefined;
}

// Standard Macintosh glyph order (post table format 2, indices < 258)
const MAC_GLYPHS = '.notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron Lslash lslash Scaron scaron Zcaron zcaron brokenbar Eth eth Yacute yacute Thorn thorn minus multiply onesuperior twosuperior threesuperior onehalf onequarter threequarters franc Gbreve gbreve Idotaccent Scedilla scedilla Cacute cacute Ccaron ccaron dcroat'.split(' ');
