/* Symbols & font integrity: ₦ $ € £ ¥ © ® ™ must never be altered when the text around them is edited,
 * every untouched glyph keeps its exact bytes and font, and only genuinely missing characters fall back. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import './register-fonts.ts';
import { SourceDoc, buildPdf, planTextEdit } from '../src/engine/engine.ts';
import { emptyState, type TextEdit } from '../src/engine/model.ts';
import type { TextGroup } from '../src/engine/interpreter.ts';

mkdirSync('tests/out', { recursive: true });
let failures = 0;
const check = (c: boolean, m: string) => { console.log(`${c ? '  ✔' : '  ✘'} ${m}`); if (!c) failures++; };
const hasPoppler = (() => { try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

async function open(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const src = await SourceDoc.open({ id: 's0', name: file, bytes });
  for (let i = 0; i < src.pageCount; i++) src.model(i); // smart scan: all fonts known (glyph borrowing)
  return { src, bytes };
}

/** glyph signature of a line: [char, font, bytes] for every glyph unit */
const sig = (g: TextGroup) => g.units.filter((u) => u.kind === 'glyph').map((u) => `${u.text}|${g.runs[u.run].font.baseFont}|${u.bytes.join(',')}`);

async function edit(file: string, find: string, mk: (t: string) => string, extra: Partial<TextEdit> = {}) {
  const { src, bytes } = await open(file);
  const g = src.model(0).groups.find((x) => x.text.includes(find))!;
  const e: TextEdit = { text: mk(g.text), ...extra };
  const plan = planTextEdit(g, e, src.fonts.all());
  const st = emptyState();
  st.pages = [{ key: 's0:0', rotate: 0 }];
  st.textEdits['s0:0'] = { [g.id]: e };
  const out = await buildPdf(new Map([['s0', src]]), 's0', st, new Map());
  const re = await SourceDoc.open({ id: 'r', name: 'r', bytes: out });
  const ng = re.model(0).groups.find((x) => x.text.replace(/\s/g, '').includes(e.text!.replace(/\s/g, '').slice(0, 12)));
  return { src, g, plan, out, ng, bytes, re };
}

console.log('\ncurrency symbols are never touched');
for (const [find, from, to, sym] of [
  ['Invoice total', '250,000.00', '275,500.00', '₦'],
  ['US price', '1,499.99', '1,999.49', '$'],
  ['US price', '1,380.00', '1,830.00', '€'],
  ['US price', '1,190.00', '1,109.00', '£'],
  ['Balance', '12,500', '21,500', '₦'],
] as const) {
  const { g, plan, ng } = await edit('tests/fixtures/money.pdf', find, (t) => t.replace(from, to));
  const before = sig(g).filter((x) => x.startsWith(sym));
  const after = ng ? sig(ng).filter((x) => x.startsWith(sym)) : [];
  check(plan.mode === 'inplace', `${from} → ${to}: written in the original fonts (${plan.mode}${plan.missing.length ? ' ' + plan.missing.join('') : ''})`);
  check(!!ng && before.length > 0 && JSON.stringify(before) === JSON.stringify(after), `${sym} glyph identical (font + bytes): ${before[0]?.split('|').slice(1, 2)}`);
}

console.log('\nevery untouched glyph keeps its exact bytes and font');
{
  const { g, ng } = await edit('tests/fixtures/money.pdf', 'Balance', (t) => t.replace('due by 30 June', 'due by 15 July'));
  const a = sig(g), b = sig(ng!);
  const keep = (s: string[]) => s.filter((x) => !/^(1|5|J|u|l|y|3|0|n|e)\|/.test(x));
  check(JSON.stringify(keep(a)) === JSON.stringify(keep(b)), `line with mixed regular/bold fonts and ¥ © ® ™ • —: all untouched glyphs identical (${a.length} → ${b.length})`);
  check(b.filter((x) => /^[12,5]\|/.test(x)).some((x) => x.includes('LiberationSans-Bold')) && b.some((x) => x.startsWith('₦|') && x.includes('CAAAAA+LiberationSans|')), 'bold amount stays bold, ₦ stays in its own (regular) subset – one line, three font runs');
}

console.log('\nsymbols available elsewhere in the document are reused, not substituted');
{
  const { plan, ng } = await edit('tests/fixtures/money.pdf', 'US price', (t) => t.replace('$1,499.99', '₦1,499.99'));
  check(plan.mode === 'inplace' && plan.missing.length === 0, `typed ₦ found in the document's own fonts (borrowed: ${plan.borrowed.join('') || 'same subset'})`);
  check(!!ng && sig(ng).some((x) => x.startsWith('₦|') && x.includes('LiberationSerif')), '₦ drawn in Liberation Serif, like the rest of the line');
}

console.log('\na genuinely missing symbol falls back for that character only');
{
  const { g, plan, ng } = await edit('tests/fixtures/money.pdf', 'Invoice total', (t) => t.replace('₦250,000.00', '₵250,000.00'));
  check(plan.missing.join('') === '₵', `only ₵ needs a fallback (${plan.substituteFont})`);
  const rest = (s: string[]) => s.filter((x) => !x.startsWith('₵') && !x.startsWith('₦'));
  check(!!ng && JSON.stringify(rest(sig(g))) === JSON.stringify(rest(sig(ng))), 'every other glyph on the line is byte-identical in its original font');
  check(!!ng && sig(ng).some((x) => x.startsWith('₵|') && /DejaVu/.test(x)), '₵ drawn with the bundled Unicode font (not "?")');
}

console.log('\nfonts without a ToUnicode map');
{
  const { src } = await open('tests/fixtures/notounicode.pdf');
  const g = src.model(0).groups[0];
  check(g.text.includes('₦5,000') && g.text.includes('€9'), `symbols decoded from the embedded font program: "${g.text}"`);
  const plan = planTextEdit(g, { text: g.text.replace('₦5,000', '₦7,250 (£40)') }, src.fonts.all());
  check(plan.mode === 'inplace', `new ₦ £ ( ) encoded from the full embedded font, no substitute (${plan.mode})`);
}

console.log('\nChrome / Google Docs Type3 fonts');
{
  const { src } = await open('tests/fixtures/chrome.pdf');
  const g = src.model(0).groups.find((x) => x.text.includes('Skia'))!;
  check(g.runs[0].font.isType3, `heading uses Type3 subsets (${new Set(g.runs.map((r) => r.font)).size} font objects)`);
  const p1 = planTextEdit(g, { text: 'Skia Export Chrome' }, src.fonts.all());
  check(p1.mode === 'inplace', `rearranged words use glyphs from the font's other subsets, no fallback (${p1.mode} ${p1.missing.join('')})`);
  const p2 = planTextEdit(g, { text: 'Chrome, Skia Export' }, src.fonts.all());
  check(p2.missing.join('') === ',', `a comma that exists nowhere in the file is the only fallback character (${p2.missing.join('') || 'none'})`);
  const p3 = planTextEdit(g, { text: 'Chrome, Skia Export' }, src.fonts.all(), { matches: { [g.runs[0].font.displayName]: 'Helvetica-Bold' } });
  check(p3.substituteFont === 'Helvetica-Bold', 'document-wide font match is used for missing characters');
}

if (hasPoppler) {
  console.log('\npixels of untouched symbols');
  const render = (b: Uint8Array, name: string) => {
    writeFileSync(`tests/out/${name}.pdf`, b);
    execFileSync('pdftoppm', ['-r', '144', '-f', '1', '-l', '1', '-singlefile', '-gray', `tests/out/${name}.pdf`, `tests/out/${name}`]);
    return readFileSync(`tests/out/${name}.pgm`);
  };
  const { g, out, bytes } = await edit('tests/fixtures/money.pdf', 'Invoice total', (t) => t.replace('payable to Ada Ventures', 'payable to Ada Ventures Ltd'));
  const a = render(bytes, 'sym_a'), b = render(out, 'sym_b');
  // region from line start up to just before "Ventures" must be pixel-identical (₦250,000.00 lives there)
  const hdr = (buf: Buffer) => { const s = buf.subarray(0, 40).toString('latin1').split(/\s+/); return { w: +s[1], h: +s[2], off: buf.indexOf(0x0a, buf.indexOf(0x0a, buf.indexOf(0x0a) + 1) + 1) + 1 }; };
  const H = hdr(a);
  const x0 = Math.floor(g.bbox.x0 * 2), x1 = Math.floor((g.bbox.x0 + (g.bbox.x1 - g.bbox.x0) * 0.62) * 2);
  const y0 = Math.floor((792 - g.bbox.y1) * 2) - 2, y1 = Math.ceil((792 - g.bbox.y0) * 2) + 2;
  let diff = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (a[H.off + y * H.w + x] !== b[H.off + y * H.w + x]) diff++;
  check(diff === 0, `"Invoice total: ₦250,000.00 payable to Ada" region pixel-identical after editing the end of the line (${diff} px differ)`);
}

console.log(failures ? `\n${failures} FAILED` : '\nsymbols passed');
process.exit(failures ? 1 : 0);
