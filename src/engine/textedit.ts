/**
 * Minimal-change line editing.
 *
 * The edited line is diffed against the original at glyph level. Every glyph
 * you did not change keeps its exact original bytes, font, kerning, colour and
 * position. Only inserted characters are encoded, in this order of preference:
 *   1. the font of the run they are typed into,
 *   2. another subset of the same typeface used on this line,
 *   3. another subset of the same typeface anywhere in the document (borrowed),
 *   4. spaces: emulated with kerning, like TeX does,
 *   5. a fallback font for just those characters (style-matched; bundled
 *      Unicode font for symbols such as ₦ ₵ ₹ that standard fonts lack).
 */
import { Encodings } from '@pdf-lib/standard-fonts';
import type { GroupUnit, TextGroup, TextRun } from './interpreter.ts';
import type { PdfFont } from './fonts.ts';
import { standardFontFor } from './fonts.ts';
import type { TextEdit } from './model.ts';

export type FontSlot =
  | { kind: 'orig'; key: string; font: PdfFont }
  | { kind: 'borrow'; font: PdfFont }
  | { kind: 'lib'; name: string };

export interface Piece {
  slot: FontSlot;
  /** encoded glyph strings and TJ numbers (orig/borrow) */
  items: (Uint8Array | number)[];
  /** unicode text (lib pieces) */
  text: string;
  /** glyph widths in 1/1000 em for orig/borrow glyphs, plus space-flags for Tw */
  glyphs: { width: number; isSpace: boolean }[];
}

export interface RunPlan {
  idx: number;
  run: TextRun;
  changed: boolean;
  pieces: Piece[];
  /** user-space length of inter-run gaps (after this run) that were deleted */
  gapRemoved: number;
}

export interface LinePlan {
  deleted: boolean;
  restyle: boolean;
  runs: RunPlan[];
  /** characters that had to come from a fallback font */
  fallbackChars: string[];
  fallbackFonts: string[];
  /** characters taken from another subset of the same typeface elsewhere in the document */
  borrowedChars: string[];
  /** missing characters per embedded font (display name) */
  missingByFont: Record<string, string[]>;
}

const BUNDLED_SANS = 'bundled:DejaVuSans';
const BUNDLED_SERIF = 'bundled:DejaVuSerif';

/** Which fallback font draws a character the original fonts lack. */
export function autoFallback(ch: string, f: PdfFont): string {
  const cp = ch.codePointAt(0)!;
  if (Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) return standardFontFor(f.baseFont, f) ?? 'Helvetica';
  const name = f.baseFont.toLowerCase();
  const serif = (f.serif || /times|serif|roman|georgia|garamond|cambria|book/.test(name)) && !/sans/.test(name);
  return (serif ? BUNDLED_SERIF : BUNDLED_SANS) + (f.bold || /bold|black|heavy/.test(name) ? '-Bold' : '');
}

const cps = (s: string) => Array.from(s.normalize('NFC'));

type Op = { t: 'keep'; u: number } | { t: 'del'; u: number } | { t: 'ins'; ch: string };

/** Glyph-level diff between the line's units and the new text (maximises untouched glyphs). */
export function diffUnits(units: GroupUnit[], text: string): Op[] {
  const U = units.map((u) => cps(u.text));
  const N = cps(text);
  const n = U.length, m = N.length;
  const matchAt = (i: number, j: number) => {
    const L = U[i];
    if (!L.length || j + L.length > m) return false;
    for (let k = 0; k < L.length; k++) if (L[k] !== N[j + k]) return false;
    return true;
  };
  const ops: Op[] = [];
  if ((n + 1) * (m + 1) > 4_000_000) {
    // very long line: common prefix/suffix only
    let a = 0;
    let j = 0;
    while (a < n && matchAt(a, j)) { ops.push({ t: 'keep', u: a }); j += U[a].length; a++; }
    let b = n, je = m;
    const tail: Op[] = [];
    while (b > a && je - U[b - 1].length >= j && U[b - 1].join('') === N.slice(je - U[b - 1].length, je).join('')) { b--; je -= U[b].length; tail.unshift({ t: 'keep', u: b }); }
    for (let i = a; i < b; i++) ops.push({ t: 'del', u: i });
    for (let k = j; k < je; k++) ops.push({ t: 'ins', ch: N[k] });
    return ops.concat(tail);
  }
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m; j >= 0; j--) {
      let best = Math.max(dp[(i + 1) * W + j], j < m ? dp[i * W + j + 1] : 0);
      if (matchAt(i, j)) best = Math.max(best, U[i].length + dp[(i + 1) * W + j + U[i].length]);
      dp[i * W + j] = best;
    }
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && matchAt(i, j) && dp[i * W + j] === U[i].length + dp[(i + 1) * W + j + U[i].length]) { ops.push({ t: 'keep', u: i }); j += U[i].length; i++; }
    else if (i < n && (j >= m || dp[i * W + j] === dp[(i + 1) * W + j])) { ops.push({ t: 'del', u: i }); i++; }
    else { ops.push({ t: 'ins', ch: N[j] }); j++; }
  }
  return ops;
}

const sameFace = (a: PdfFont, b: PdfFont) => a === b || (a.displayName === b.displayName && a.subtype === b.subtype);

export interface FallbackPrefs {
  /** font chosen for characters missing from a given embedded font (by display name) */
  matches?: Record<string, string>;
  /** whether a fallback font can draw a character (for uploaded/fetched fonts) */
  covers?: (font: string, ch: string) => boolean;
}

export function planLine(group: TextGroup, edit: TextEdit, pool: PdfFont[] = [], prefs: FallbackPrefs = {}): LinePlan {
  const restyle = !!(edit.dx || edit.dy || edit.rotate || (edit.scale && edit.scale !== 1) || edit.color || edit.opacity !== undefined || edit.forceFallback);
  const plan: LinePlan = { deleted: !!edit.deleted, restyle, runs: [], fallbackChars: [], fallbackFonts: [], borrowedChars: [], missingByFont: {} };
  const runs = group.runs;
  if (edit.deleted) {
    plan.runs = runs.map((run, idx) => ({ idx, run, changed: true, pieces: [], gapRemoved: 0 }));
    return plan;
  }
  const text = edit.text ?? group.text;
  const units = group.units;
  const ops: Op[] = edit.forceFallback
    ? [...units.map((_, u) => ({ t: 'del', u }) as Op), ...cps(text).map((ch) => ({ t: 'ins', ch }) as Op)]
    : diffUnits(units, text);

  // assign operations to runs
  const per: { entries: ({ k: 'keep'; u: GroupUnit } | { k: 'ins'; ch: string })[]; changed: boolean; gapRemoved: number }[] =
    runs.map(() => ({ entries: [], changed: false, gapRemoved: 0 }));
  let cur = units.length ? units[0].run : 0;
  for (const op of ops) {
    if (op.t === 'ins') {
      per[cur].entries.push({ k: 'ins', ch: op.ch });
      per[cur].changed = true;
      continue;
    }
    const u = units[op.u];
    cur = u.run;
    if (op.t === 'keep') {
      if (!u.gap) per[u.run].entries.push({ k: 'keep', u });
    } else {
      per[u.run].changed = true;
      if (u.gap) per[u.run].gapRemoved += u.gapLen ?? 0;
    }
  }

  // a typical space for this line, if the fonts have no space glyph
  const kernSpace = units.find((u) => u.kind === 'kern' && !u.gap)?.tj;
  const lineFonts = runs.map((r) => ({ key: r.fontKey, font: r.font }));

  runs.forEach((run, idx) => {
    const p = per[idx];
    const all = restyle;
    if (!p.changed && !all) {
      plan.runs.push({ idx, run, changed: false, pieces: [], gapRemoved: 0 });
      return;
    }
    const pieces: Piece[] = [];
    const own: FontSlot = { kind: 'orig', key: run.fontKey, font: run.font };
    const piece = (slot: FontSlot) => {
      const last = pieces[pieces.length - 1];
      const same = last && last.slot.kind === slot.kind &&
        (slot.kind === 'lib' ? (last.slot as { name: string }).name === slot.name : (last.slot as { font: PdfFont }).font === (slot as { font: PdfFont }).font);
      if (same) return last;
      const np: Piece = { slot, items: [], text: '', glyphs: [] };
      pieces.push(np);
      return np;
    };
    if (!p.changed) {
      // unchanged run in a restyled line: its original operands, verbatim
      const pc = piece(own);
      pc.items.push(...run.items);
      for (const u of run.units) if (u.kind === 'glyph') pc.glyphs.push({ width: u.width, isSpace: u.isSpace });
    } else {
      const entries = p.entries;
      for (let e = 0; e < entries.length; ) {
        const en = entries[e];
        if (en.k === 'keep') {
          const u = en.u;
          const pc = piece(own);
          pc.items.push(...u.pre);
          if (u.kind === 'glyph') {
            pc.items.push(Uint8Array.from(u.bytes));
            pc.glyphs.push({ width: u.width, isSpace: u.isSpace });
          } else pc.items.push(u.tj);
          e++;
          continue;
        }
        // run of inserted characters
        const chars: string[] = [];
        while (e < entries.length && entries[e].k === 'ins') chars.push((entries[e++] as { ch: string }).ch);
        for (let c = 0; c < chars.length; ) {
          // 1–3: original typefaces (own run, same face on this line, same face elsewhere in the document)
          const cands: FontSlot[] = edit.forceFallback ? [] : [own];
          if (!edit.forceFallback) {
            for (const lf of lineFonts) if (lf.font !== run.font && sameFace(lf.font, run.font)) cands.push({ kind: 'orig', key: lf.key, font: lf.font });
            for (const f of pool) if (f !== run.font && f.ref && sameFace(f, run.font) && !lineFonts.some((x) => x.font === f)) cands.push({ kind: 'borrow', font: f });
          }
          let done = false;
          for (const slot of cands) {
            const f = (slot as { font: PdfFont }).font;
            const hit = f.matchAt(chars, c);
            if (!hit) continue;
            const pc = piece(slot);
            pc.items.push(Uint8Array.from(hit.glyph.bytes));
            pc.glyphs.push({ width: hit.glyph.width, isSpace: hit.glyph.isSpace });
            if (slot.kind === 'borrow') plan.borrowedChars.push(chars.slice(c, c + hit.len).join(''));
            c += hit.len;
            done = true;
            break;
          }
          if (done) continue;
          const ch = chars[c];
          if (!edit.forceFallback && /^[  \t]$/.test(ch)) {
            // 4: space emulated with kerning in the run's own font
            const pc = piece(own);
            pc.items.push(kernSpace ?? -run.font.spaceWidth() * (ch === '\t' ? 4 : 1));
            c++;
            continue;
          }
          // 5: fallback for this character only
          // a matched font may come in several parts (e.g. latin + latin-ext); use the first that has the glyph
          const matched = prefs.matches?.[run.font.displayName]?.split('|').find((m) => prefs.covers?.(m, ch) ?? true);
          const name = edit.fallbackFont ?? matched ?? autoFallback(ch, run.font);
          const pc = piece({ kind: 'lib', name });
          pc.text += ch;
          if (!/\s/.test(ch)) {
            plan.fallbackChars.push(ch);
            (plan.missingByFont[run.font.displayName] ??= []).push(ch);
          }
          if (!plan.fallbackFonts.includes(name)) plan.fallbackFonts.push(name);
          c++;
        }
      }
      if (run.trailing.length) piece(own).items.push(...run.trailing);
    }
    plan.runs.push({ idx, run, changed: true, pieces, gapRemoved: p.gapRemoved });
  });
  return plan;
}
