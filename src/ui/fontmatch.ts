/**
 * Automatic font matching.
 *
 * When you type a character the PDF's embedded (subset) font doesn't contain,
 * the real typeface is fetched from Fontsource (Google Fonts and other open
 * fonts). Commercial fonts get their metric-compatible open twin: same widths,
 * and same shapes for the Liberation/Croscore families. Only the font *name*
 * is requested; the document never leaves the device. Downloads are cached in
 * IndexedDB, so each font is fetched once and then works offline.
 */
import { parseFontProgram } from '../engine/fontprog.ts';

export function parseFontName(n: string): { family: string; weight: number; italic: boolean } {
  const clean = n.replace(/^[A-Z]{6}\+/, '').replace(/,/g, '-').replace(/(PSMT|MT|PS)$/, '');
  const m = /^(.*?)[-_ ]?((?:Thin|Hairline|ExtraLight|UltraLight|Light|Regular|Book|Normal|Medium|SemiBold|DemiBold|Semibold|Demibold|ExtraBold|UltraBold|Bold|Black|Heavy)?(?:Italic|Oblique|It)?)$/.exec(clean);
  const family = (m?.[1] || clean).replace(/[-_]+$/, '').replace(/(PS|MT)+$/, '') || clean;
  const style = (m?.[2] || '').toLowerCase();
  const weights: [RegExp, number][] = [[/thin|hairline/, 100], [/extralight|ultralight/, 200], [/light/, 300], [/medium/, 500], [/semibold|demibold/, 600], [/extrabold|ultrabold/, 800], [/bold/, 700], [/black|heavy/, 900]];
  const weight = weights.find(([re]) => re.test(style))?.[1] ?? 400;
  return { family, weight, italic: /italic|oblique|it$/.test(style) };
}

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: '', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
export function prettyName(n: string) {
  const p = parseFontName(n);
  return [spaced(p.family), WEIGHT_NAMES[p.weight], p.italic ? 'Italic' : ''].filter(Boolean).join(' ');
}
const spaced = (f: string) => f.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

/** Open twins for common commercial fonts. `metric` = identical advance widths. */
const TWINS: Record<string, { id: string; metric: boolean }> = {
  arial: { id: 'arimo', metric: true }, helvetica: { id: 'arimo', metric: true }, helveticaneue: { id: 'arimo', metric: true },
  liberationsans: { id: 'arimo', metric: true }, timesnewroman: { id: 'tinos', metric: true }, times: { id: 'tinos', metric: true },
  timesroman: { id: 'tinos', metric: true }, liberationserif: { id: 'tinos', metric: true }, couriernew: { id: 'cousine', metric: true },
  courier: { id: 'cousine', metric: true }, liberationmono: { id: 'cousine', metric: true }, calibri: { id: 'carlito', metric: true },
  cambria: { id: 'caladea', metric: true }, georgia: { id: 'gelasio', metric: true }, segoeui: { id: 'open-sans', metric: false },
  verdana: { id: 'pt-sans', metric: false }, tahoma: { id: 'pt-sans', metric: false }, garamond: { id: 'eb-garamond', metric: false },
  bookantiqua: { id: 'eb-garamond', metric: false }, palatinolinotype: { id: 'eb-garamond', metric: false }, palatino: { id: 'eb-garamond', metric: false },
  centurygothic: { id: 'questrial', metric: false }, trebuchetms: { id: 'fira-sans', metric: false }, franklingothic: { id: 'libre-franklin', metric: false },
  gillsans: { id: 'lato', metric: false }, futura: { id: 'jost', metric: false }, avenir: { id: 'nunito-sans', metric: false },
  sfprotext: { id: 'inter', metric: false }, sfprodisplay: { id: 'inter', metric: false }, aptos: { id: 'inter', metric: false },
};

export interface MatchCandidate { id: string; label: string; exact: boolean }

export function candidatesFor(fontName: string): MatchCandidate[] {
  const { family } = parseFontName(fontName);
  const norm = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  const exactId = spaced(family).trim().toLowerCase().replace(/[\s_]+/g, '-');
  const out: MatchCandidate[] = [];
  const twin = TWINS[norm];
  if (!norm.startsWith('liberation')) out.push({ id: exactId, label: spaced(family), exact: true });
  if (twin && twin.id !== exactId) out.push({ id: twin.id, label: `${spaced(twin.id.replace(/-/g, ' ')).replace(/\b\w/g, (c) => c.toUpperCase())} (${twin.metric ? 'metric twin' : 'closest open match'} of ${spaced(family)})`, exact: false });
  return out;
}

function subsetsFor(chars: string[]): string[] {
  const s = new Set(['latin', 'latin-ext']);
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x370 && cp <= 0x3ff) s.add('greek');
    else if (cp >= 0x400 && cp <= 0x52f) s.add('cyrillic');
    else if ((cp >= 0x1ea0 && cp <= 0x1ef9) || cp === 0x20ab) s.add('vietnamese');
  }
  return [...s];
}

// ---------------------------------------------------------------- cache
const DB = 'deep-pdf-editor-fonts';
function idb(): Promise<IDBDatabase | undefined> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fonts');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
    } catch {
      res(undefined);
    }
  });
}
async function cacheGet(url: string): Promise<Uint8Array | null | undefined> {
  const db = await idb();
  if (!db) return undefined;
  return new Promise((res) => {
    try {
      const q = db.transaction('fonts').objectStore('fonts').get(url);
      q.onsuccess = () => res(q.result === undefined ? undefined : q.result === null ? null : new Uint8Array(q.result as ArrayBuffer));
      q.onerror = () => res(undefined);
    } catch {
      res(undefined);
    }
  });
}
async function cachePut(url: string, bytes: Uint8Array | null) {
  const db = await idb();
  if (!db) return;
  try {
    db.transaction('fonts', 'readwrite').objectStore('fonts').put(bytes ? bytes.slice().buffer : null, url);
  } catch { /* quota / private mode */ }
}
const missing404 = new Set<string>();
async function fetchFont(url: string): Promise<Uint8Array | undefined> {
  if (missing404.has(url)) return undefined;
  const c = await cacheGet(url);
  if (c) return c;
  if (c === null) return undefined;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      missing404.add(url);
      if (r.status === 404) cachePut(url, null);
      return undefined;
    }
    const b = new Uint8Array(await r.arrayBuffer());
    cachePut(url, b);
    return b;
  } catch {
    return undefined; // offline / blocked
  }
}

export interface FontPart { bytes: Uint8Array; label: string }

/** Download the parts of the matching open font that cover `need`. */
export async function downloadMatch(fontName: string, need: string[]): Promise<{ parts: FontPart[]; candidate?: MatchCandidate }> {
  const { weight, italic } = parseFontName(fontName);
  const chars = [...new Set(need)];
  const style = italic ? 'italic' : 'normal';
  const weights = [...new Set([weight, weight >= 600 ? 700 : 400, 400, 500, 700, 300])];
  for (const cand of candidatesFor(fontName)) {
    const parts: FontPart[] = [];
    const covered = new Set<string>();
    for (const subset of subsetsFor(chars)) {
      let bytes: Uint8Array | undefined;
      let w = weight;
      for (const tryW of weights) {
        bytes = await fetchFont(`https://cdn.jsdelivr.net/fontsource/fonts/${cand.id}@latest/${subset}-${tryW}-${style}.ttf`);
        if (bytes) { w = tryW; break; }
      }
      if (!bytes) {
        if (subset === 'latin') break; // family not on Fontsource
        continue;
      }
      const cm = parseFontProgram(bytes, 'FontFile2')?.unicodeCmap;
      const adds = chars.filter((c) => !covered.has(c) && cm?.has(c.codePointAt(0)!));
      if (!adds.length && parts.length) continue;
      adds.forEach((c) => covered.add(c));
      parts.push({ bytes, label: `${cand.label}${WEIGHT_NAMES[w] ? ' ' + WEIGHT_NAMES[w] : ''}${italic ? ' Italic' : ''}${subset === 'latin' ? '' : ` (${subset})`}` });
      if (covered.size === chars.length) break;
    }
    if (parts.length && covered.size) return { parts, candidate: cand };
  }
  return { parts: [] };
}

// ---------------------------------------------------------------- on-screen editor fonts
const WEIGHTS_TRY = (w: number) => [...new Set([w, w >= 600 ? 700 : 400, 400, 500, 700])];
const loadedFaces = new Map<string, Promise<void>>();

/** CSS font-family list for the inline editor: the real face (fetched & cached) first, then installed/generic. */
export function editorFontFamily(fontName: string, generic: string): string {
  const { weight, italic } = parseFontName(fontName);
  const fams: string[] = [];
  for (const c of candidatesFor(fontName)) {
    const fam = `dpe-${c.id}-${weight}${italic ? 'i' : ''}`;
    fams.push(`"${fam}"`);
    if (!loadedFaces.has(fam)) loadedFaces.set(fam, loadFace(fam, c.id, weight, italic));
  }
  const { family } = parseFontName(fontName);
  return [...fams, `"${spaced(family)}"`, `"${family}"`, generic].join(', ');
}

async function loadFace(fam: string, id: string, weight: number, italic: boolean) {
  for (const w of WEIGHTS_TRY(weight)) {
    const bytes = await fetchFont(`https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${w}-${italic ? 'italic' : 'normal'}.ttf`);
    if (!bytes) continue;
    try {
      const ff = new FontFace(fam, bytes as BufferSource);
      await ff.load();
      document.fonts.add(ff);
    } catch { /* unusable font */ }
    return;
  }
}

export function cssWeight(fontName: string, bold: boolean): number {
  const w = parseFontName(fontName).weight;
  return bold && w < 600 ? 700 : w;
}
