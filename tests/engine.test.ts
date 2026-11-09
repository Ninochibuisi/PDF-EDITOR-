/* Engine round-trip tests: edit text in real PDFs and verify via pdf.js + re-interpretation. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import './register-fonts.ts';
import { SourceDoc, buildPdf, planTextEdit } from '../src/engine/engine.ts';
import { emptyState, type EditorState } from '../src/engine/model.ts';

mkdirSync('tests/out', { recursive: true });
let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) failures++;
};

async function extract(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages: { text: string; fonts: Set<string> }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    const items = tc.items as { str: string; fontName: string }[];
    pages.push({ text: items.map((x) => x.str).join(' '), fonts: new Set(items.filter((x) => x.str.trim()).map((x) => tc.styles[x.fontName]?.fontFamily + '|' + x.fontName)) });
  }
  return pages;
}

async function open(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const src = await SourceDoc.open({ id: 's0', name: file, bytes });
  const state: EditorState = emptyState();
  state.pages = Array.from({ length: src.pageCount }, (_, i) => ({ key: `s0:${i}`, rotate: 0 }));
  return { src, state, sources: new Map([['s0', src]]) };
}

async function editCase(file: string, find: string, replacement: string) {
  console.log(`\n${file}: "${find}" -> "${replacement}"`);
  const { src, state, sources } = await open(file);
  const m = src.model(0);
  console.log('  groups:', m.groups.map((g) => `[${g.runs[0].font.displayName}] ${g.text}`).join(' | '));
  const g = m.groups.find((g) => g.text.includes(find));
  check(!!g, 'found group containing target');
  if (!g) return;
  const edit = { text: g.text.replace(find, replacement) };
  const plan = planTextEdit(g, edit);
  console.log('  plan:', plan.mode, plan.missing.join(''));
  state.textEdits['s0:0'] = { [g.id]: edit };
  const out = await buildPdf(sources, 's0', state, new Map());
  writeFileSync(`tests/out/${file.split('/').pop()}`, out);
  const before = await extract(src.info.bytes);
  const after = await extract(out);
  check(after[0].text.replace(/\s/g, '').includes(replacement.replace(/\s/g, '')), 'new text is present in output');
  check(!after[0].text.includes(find) || g.text.replace(find, '').includes(find), 'old text is gone');
  void before;
  // re-interpret: other groups untouched
  const re = await SourceDoc.open({ id: 'x', name: 'x', bytes: out });
  if (plan.mode === 'inplace') {
    const ng = re.model(0).groups.find((x) => x.text.includes(replacement));
    check(!!ng && ng.runs[0].font.baseFont === g.runs[0].font.baseFont, `edited text still uses original font (${ng?.runs[0].font.baseFont})`);
  }
  const others = m.groups.filter((x) => x !== g).map((x) => x.text);
  const reTexts = re.model(0).groups.map((x) => x.text).join('\n');
  check(others.every((t) => reTexts.includes(t)), 'all other lines preserved');
  return plan;
}

await editCase('tests/fixtures/std.pdf', 'World', 'There');
check((await editCase('tests/fixtures/ttf.pdf', '1,250.00', '2,015.50'))?.mode === 'inplace', 'subset glyphs reused in place');
check((await editCase('tests/fixtures/ttf.pdf', '1,250.00', '9,999.10'))?.mode === 'substitute', 'digit 9 not in subset -> honest fallback');
await editCase('tests/fixtures/doc.pdf', 'lazy dog', 'sleepy cat');
await editCase('tests/fixtures/doc.pdf', 'Quarterly', 'Annual');
await editCase('tests/fixtures/doc.pdf', '555-0100', '555-0199');
// glyph not in subset -> substitute font path
const p = await editCase('tests/fixtures/ttf.pdf', 'business', 'qzqz');
check(p?.mode === 'substitute', 'missing glyphs fall back to substitute font');

// structural ops + overlays + redaction
{
  console.log('\nstructure/overlays/redaction');
  const { state, sources } = await open('tests/fixtures/doc.pdf');
  const a = await open('tests/fixtures/std.pdf');
  sources.set('s1', (a.src.info.id = 's1', a.src));
  state.pages = [{ key: 's1:0', rotate: 90 }, { key: 'blank:1', rotate: 0, size: [300, 300] }, { key: 's0:0', rotate: 0 }];
  state.overlays['s0:0'] = [
    { id: 'o1', type: 'text', x: 72, y: 72, w: 200, h: 30, rot: 0, text: 'Approved stamp', size: 14, color: [1, 0, 0], font: 'Helvetica-Bold' },
    { id: 'o2', type: 'highlight', x: 60, y: 600, w: 200, h: 20, rot: 0 },
  ];
  const g = sources.get('s0')!.model(0).groups.find((g) => g.text.includes('jane.doe'))!;
  const bb = g.bbox;
  state.overlays['s0:0'].push({ id: 'r', type: 'redact', x: bb.x0 - 1, y: bb.y0 - 1, w: (bb.x1 - bb.x0) * 0.6, h: bb.y1 - bb.y0 + 2, rot: 0 });
  state.meta.title = 'Edited';
  const out = await buildPdf(sources, 's0', state, new Map());
  writeFileSync('tests/out/combined.pdf', out);
  const t = await extract(out);
  check(t.length === 3, '3 pages after merge + blank insert');
  check(t[0].text.includes('Hello World'), 'imported page first');
  check(t[2].text.includes('Approved stamp'), 'text overlay drawn');
  check(!t[2].text.includes('jane.doe'), 'redacted text removed from content');
  check(t[2].text.includes('Quarterly'), 'unredacted text kept');
  const d = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
  check((await d.getPage(1)).rotate === 90, 'rotation applied');
  check(((await d.getMetadata()).info as { Title?: string }).Title === 'Edited', 'metadata title set');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
