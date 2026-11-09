/* Quality guarantees:
 *  - pixels outside an edited line are identical to the original
 *  - edited / moved / substituted text keeps its exact colour and transparency
 *  - watermarks are detected, removed, added and re-detected
 *  - incremental export keeps the original bytes verbatim
 * Rendering checks use poppler's pdftoppm when available. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import './register-fonts.ts';
import { SourceDoc, buildPdf } from '../src/engine/engine.ts';
import { scanDocument, type PageInfo } from '../src/engine/watermarks.ts';
import { emptyState, type EditorState } from '../src/engine/model.ts';

mkdirSync('tests/out', { recursive: true });
let failures = 0;
const check = (c: boolean, m: string) => { console.log(`${c ? '  ✔' : '  ✘'} ${m}`); if (!c) failures++; };
const hasPoppler = (() => { try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

interface Img { w: number; h: number; px: Uint8Array }
function render(bytes: Uint8Array, dpi = 72): Img {
  writeFileSync('tests/out/_r.pdf', bytes);
  execFileSync('pdftoppm', ['-r', String(dpi), '-f', '1', '-l', '1', '-singlefile', 'tests/out/_r.pdf', 'tests/out/_r']);
  const buf = readFileSync('tests/out/_r.ppm');
  // P6\nW H\n255\n<data>
  let i = 0; const tok: string[] = [];
  while (tok.length < 4) {
    while (buf[i] === 0x20 || buf[i] === 0x0a) i++;
    let s = ''; while (buf[i] !== 0x20 && buf[i] !== 0x0a) s += String.fromCharCode(buf[i++]);
    tok.push(s);
  }
  return { w: +tok[1], h: +tok[2], px: new Uint8Array(buf.buffer, buf.byteOffset + i + 1) };
}
/** count differing pixels outside the given user-space boxes (page height for y flip, 72dpi) */
function diffOutside(a: Img, b: Img, pageH: number, boxes: { x0: number; y0: number; x1: number; y1: number }[], pad = 3) {
  let n = 0;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const ux = x, uy = pageH - y;
    if (boxes.some((r) => ux >= r.x0 - pad && ux <= r.x1 + pad && uy >= r.y0 - pad && uy <= r.y1 + pad)) continue;
    const k = (y * a.w + x) * 3;
    if (a.px[k] !== b.px[k] || a.px[k + 1] !== b.px[k + 1] || a.px[k + 2] !== b.px[k + 2]) n++;
  }
  return n;
}
/** the most "inked" colour inside a box (darkest pixel by luma) */
function inkColor(img: Img, pageH: number, r: { x0: number; y0: number; x1: number; y1: number }) {
  let best = [255, 255, 255], bl = 1e9;
  for (let y = Math.max(0, Math.floor(pageH - r.y1)); y < Math.min(img.h, Math.ceil(pageH - r.y0)); y++)
    for (let x = Math.max(0, Math.floor(r.x0)); x < Math.min(img.w, Math.ceil(r.x1)); x++) {
      const k = (y * img.w + x) * 3;
      const l = img.px[k] * 0.3 + img.px[k + 1] * 0.59 + img.px[k + 2] * 0.11;
      if (l < bl) { bl = l; best = [img.px[k], img.px[k + 1], img.px[k + 2]]; }
    }
  return best;
}
const colorClose = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function open(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const src = await SourceDoc.open({ id: 's0', name: file, bytes });
  const state: EditorState = emptyState();
  state.pages = Array.from({ length: src.pageCount }, (_, i) => ({ key: `s0:${i}`, rotate: 0 }));
  return { src, state, sources: new Map([['s0', src]]), bytes };
}
async function texts(bytes: Uint8Array) {
  const d = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= d.numPages; i++) out.push(((await (await d.getPage(i)).getTextContent()).items as { str: string }[]).map((x) => x.str).join(' '));
  return out;
}

// ---------------------------------------------------------------- fidelity
console.log('\ncolour & pixel fidelity');
{
  const { src, state, sources, bytes } = await open('tests/fixtures/color.pdf');
  const gs = src.model(0).groups;
  const head = gs.find((g) => g.text.startsWith('Semi'))!;
  const body = gs.find((g) => g.text.startsWith('Teal'))!;
  check(head.runs[0].alpha < 1, `transparency is detected (ca=${head.runs[0].alpha})`);
  // in place edit, a moved edit and a substitute-font edit (Q is not in the subset? standard font -> all glyphs available; force fallback)
  state.textEdits['s0:0'] = {
    [head.id]: { text: 'Semi transparent crimson HEADLINE', dx: 6, dy: 4 },
    [body.id]: { text: 'Teal body copy that keeps its exact shade', forceFallback: true, fallbackFont: 'Helvetica' },
  };
  const out = await buildPdf(sources, 's0', state, new Map());
  const outInc = await buildPdf(sources, 's0', state, new Map(), { incremental: true });
  writeFileSync('tests/out/color-edited.pdf', out);
  writeFileSync('tests/out/color-incremental.pdf', outInc);
  const t = await texts(out);
  check(t[0].includes('HEADLINE') && t[0].includes('keeps its exact shade'), 'edits applied');
  if (hasPoppler) {
    const a = render(bytes), b = render(out), c = render(outInc);
    const pad = (g: typeof head) => ({ x0: g.bbox.x0 - 2, y0: g.bbox.y0 - 2, x1: Math.max(g.bbox.x1, 560) + 8, y1: g.bbox.y1 + 8 });
    const d = diffOutside(a, b, 792, [pad(head), pad(body)]);
    check(d === 0, `no pixel outside the edited lines changed (${d} differ)`);
    check(diffOutside(b, c, 792, []) === 0, 'incremental and rebuilt exports render identically');
    for (const [g, name] of [[head, 'translucent crimson (moved)'], [body, 'teal (substitute font)']] as const) {
      const before = inkColor(a, 792, g.bbox);
      const after = inkColor(b, 792, { x0: g.bbox.x0, y0: g.bbox.y0, x1: g.bbox.x1 + 10, y1: g.bbox.y1 + 6 });
      check(colorClose(before, after), `${name} colour identical: ${before} → ${after}`);
    }
  } else console.log('  (pdftoppm not installed – pixel checks skipped)');
  // incremental: original bytes untouched
  check(outInc.length > bytes.length && bytes.every((v, i) => outInc[i] === v), 'incremental export keeps every original byte verbatim');
  const ti = await texts(outInc);
  check(ti[0] === t[0], 'incremental export has the same content');
}

// ---------------------------------------------------------------- watermarks
console.log('\nwatermarks');
const pageInfos = (src: SourceDoc, keys: string[]): PageInfo[] =>
  keys.map((key, i) => { const s = src.pageSize(i); return { key, number: i + 1, model: src.model(i), box: [s.box[0], s.box[1], s.box[2], s.box[3]] }; });
{
  const { src, state, sources } = await open('tests/fixtures/watermarked.pdf');
  const rep = scanDocument(pageInfos(src, state.pages.map((p) => p.key)));
  const wm = rep.watermarks.find((w) => /confidential/i.test(w.label));
  check(!!wm && wm.hits.length === 3, `untagged "CONFIDENTIAL" detected on ${wm?.hits.length} pages (${wm?.reason})`);
  check(!rep.watermarks.some((w) => /body text/i.test(w.label)), 'body text is not mistaken for a watermark');
  check(Math.abs((wm?.sample?.angle ?? 0) - 45) < 1 && (wm?.sample?.opacity ?? 1) < 0.5, `sample props read back (angle ${wm?.sample?.angle}, opacity ${wm?.sample?.opacity})`);

  // edit the existing watermark in place (original font): new text + new opacity on every page
  const s1 = structuredClone(state);
  for (const h of wm!.hits) for (const gid of h.groupIds) (s1.textEdits[h.key] ??= {})[gid] = { text: 'APPROVED', opacity: 0.15 };
  const edited = await texts(await buildPdf(sources, 's0', s1, new Map()));
  check(edited.every((t) => t.includes('APPROVED') && !t.includes('CONFIDENTIAL')), 'existing watermark re-texted on all pages');

  // remove it
  const s2 = structuredClone(state);
  for (const h of wm!.hits) s2.removals[h.key] = h.targets;
  const removed = await buildPdf(sources, 's0', s2, new Map());
  const rt = await texts(removed);
  check(rt.every((t) => !t.includes('CONFIDENTIAL') && t.includes('body text')), 'watermark removed, body kept');

  // add a new one, export, re-open, it is found as a tagged artifact and removable
  s2.watermarks.push({ id: 'w1', kind: 'text', text: 'DRAFT v2', font: 'Helvetica-Bold', size: 72, color: [0.9, 0.2, 0.2], opacity: 0.25, angle: 30, position: 'center', layer: 'over', pages: '', enabled: true });
  const added = await buildPdf(sources, 's0', s2, new Map());
  writeFileSync('tests/out/watermark-added.pdf', added);
  check((await texts(added)).every((t) => t.includes('DRAFT v2')), 'new watermark on every page');
  const re = await SourceDoc.open({ id: 's0', name: 'x', bytes: added });
  const rep2 = scanDocument(pageInfos(re, [0, 1, 2].map((i) => `s0:${i}`)));
  const tagged = rep2.watermarks.find((w) => w.kind === 'artifact');
  check(!!tagged && tagged.label.includes('DRAFT') && tagged.hits.length === 3, `re-opened: detected as tagged watermark artifact on ${tagged?.hits.length} pages`);
  const st3 = emptyState();
  st3.pages = [0, 1, 2].map((i) => ({ key: `s0:${i}`, rotate: 0 }));
  for (const h of tagged!.hits) st3.removals[h.key] = h.targets;
  const cleaned = await texts(await buildPdf(new Map([['s0', re]]), 's0', st3, new Map(), { incremental: true }));
  check(cleaned.every((t) => !t.includes('DRAFT') && t.includes('body text')), 'tagged watermark removed again (incremental save)');

  // tiled + image-free + page range
  const s4 = structuredClone(state);
  s4.watermarks.push({ id: 'w2', kind: 'text', text: 'SAMPLE', font: 'Times-Roman', size: 30, color: [0, 0, 0.6], opacity: 0.2, angle: -20, position: 'tile', layer: 'under', pages: '2', enabled: true });
  const tiled = await texts(await buildPdf(sources, 's0', s4, new Map()));
  check(!tiled[0].includes('SAMPLE') && (tiled[1].match(/SAMPLE/g) ?? []).length > 4 && !tiled[2].includes('SAMPLE'), 'tiled watermark only on page 2');
}

// ---------------------------------------------------------------- incremental validity on every fixture
console.log('\nincremental export');
for (const f of ['doc.pdf', 'chrome.pdf', 'form.pdf', 'ttf.pdf']) {
  const { src, state, sources, bytes } = await open('tests/fixtures/' + f);
  const g = src.model(0).groups.find((x) => x.text.trim().length > 3)!;
  state.textEdits['s0:0'] = { [g.id]: { text: [...g.text].reverse().join('') } };
  const out = await buildPdf(sources, 's0', state, new Map(), { incremental: true });
  const prefix = bytes.every((v, i) => out[i] === v);
  const t = await texts(out);
  let qpdfOk = true;
  if (hasPoppler) { try { render(out); } catch { qpdfOk = false; } }
  if (existsSync('/usr/bin/qpdf')) {
    writeFileSync('tests/out/_inc.pdf', out);
    try { execFileSync('qpdf', ['--check', 'tests/out/_inc.pdf'], { stdio: 'pipe' }); } catch (e) { qpdfOk = /warning/i.test(String((e as { stdout?: Buffer }).stdout)); }
  }
  check(prefix && t[0].replace(/\s/g, '').includes([...g.text].reverse().join('').replace(/\s/g, '').slice(0, 20)) && qpdfOk, `${f}: original bytes preserved, edit visible${existsSync('/usr/bin/qpdf') ? ', qpdf --check ok' : ''} (+${out.length - bytes.length} bytes)`);
}

console.log(failures ? `\n${failures} FAILED` : '\nquality passed');
process.exit(failures ? 1 : 0);
