/* Layout: alignment is detected and kept when text changes; boxes (frames) and alignment can be set. */
import { readFileSync } from 'node:fs';
import './register-fonts.ts';
import { SourceDoc, buildPdf } from '../src/engine/engine.ts';
import { detectAlignment } from '../src/engine/layout.ts';
import { emptyState, type TextEdit } from '../src/engine/model.ts';

let failures = 0;
const check = (c: boolean, m: string) => { console.log(`${c ? '  ✔' : '  ✘'} ${m}`); if (!c) failures++; };
const src = await SourceDoc.open({ id: 's0', name: 'c', bytes: new Uint8Array(readFileSync('tests/fixtures/certificate.pdf')) });
const groups = src.model(0).groups;
const page = { x: 0, w: 842 };
const find = (t: string) => groups.find((g) => g.text.includes(t))!;

console.log('\nalignment detection');
for (const [t, want] of [['CERTIFICATE', 'center'], ['ADAEZE', 'center'], ['This certifies', 'center'], ['Lagos', 'right'], ['Signed', 'right'], ['Reference', 'left'], ['Verify', 'left']] as const) {
  const a = detectAlignment(find(t), groups, page);
  check(a.align === want, `"${find(t).text.trim()}" → ${a.align} (${a.reason})`);
}

async function edited(t: string, e: TextEdit) {
  const g = find(t);
  const st = emptyState();
  st.pages = [{ key: 's0:0', rotate: 0 }];
  st.textEdits['s0:0'] = { [g.id]: e };
  const out = await buildPdf(new Map([['s0', src]]), 's0', st, new Map());
  const re = await SourceDoc.open({ id: 'r', name: 'r', bytes: out });
  return re.model(0).groups.find((x) => x.text.replace(/\s/g, '').includes((e.text ?? g.text).replace(/\s/g, '').slice(0, 10)))!;
}
const cx = (g: { bbox: { x0: number; x1: number } }) => (g.bbox.x0 + g.bbox.x1) / 2;

console.log('\nedits keep the original alignment');
{
  const g = find('ADAEZE');
  const n = await edited('ADAEZE', { text: 'OLUWAYEMISI ARIGBEDE' });
  check(Math.abs(cx(n) - cx(g)) < 0.6, `longer centred name stays centred (${cx(g).toFixed(1)} → ${cx(n).toFixed(1)})`);
  const s = await edited('ADAEZE', { text: 'ADA OKE' });
  check(Math.abs(cx(s) - cx(g)) < 0.6, `shorter centred name stays centred (${cx(s).toFixed(1)})`);
  const d = find('Lagos');
  const dn = await edited('Lagos', { text: 'Abuja, 3 March 2027' });
  check(Math.abs(dn.bbox.x1 - d.bbox.x1) < 0.6, `right-aligned date keeps its right edge (${d.bbox.x1.toFixed(1)} → ${dn.bbox.x1.toFixed(1)})`);
  const r = find('Reference');
  const rn = await edited('Reference', { text: 'Reference: CERT-2026-0042-B' });
  check(Math.abs(rn.bbox.x0 - r.bbox.x0) < 0.3, 'left-aligned line keeps its left edge');
}

console.log('\nboxes and manual alignment');
{
  const g = find('ADAEZE');
  const w = g.bbox.x1 - g.bbox.x0;
  const l = await edited('ADAEZE', { text: 'ADA OKE', align: 'left' });
  check(Math.abs(l.bbox.x0 - g.bbox.x0) < 0.6, 'forced left: starts at the box start');
  const r = await edited('ADAEZE', { text: 'ADA OKE', align: 'right' });
  check(Math.abs(r.bbox.x1 - g.bbox.x1) < 0.6, 'forced right: ends at the box end');
  // widen the box 100pt to the right, centred → centre moves 50pt
  const f = await edited('ADAEZE', { text: 'ADAEZE OKONKWO', frame: [0, w + 100] });
  check(Math.abs(cx(f) - (cx(g) + 50)) < 0.8, `wider box re-centres the text (${cx(f).toFixed(1)} vs ${(cx(g) + 50).toFixed(1)})`);
  const fit = await edited('ADAEZE', { text: 'OLUWAYEMISI ARIGBEDE ADEYEMI', fit: true });
  check(fit.bbox.x1 - fit.bbox.x0 <= w + 1 && Math.abs(cx(fit) - cx(g)) < 1, `fit + centre: shrunk into the box and still centred (${(fit.bbox.x1 - fit.bbox.x0).toFixed(1)} ≤ ${w.toFixed(1)})`);
  const mv = await edited('ADAEZE', { dx: 30, dy: -12 });
  check(Math.abs(mv.bbox.x0 - g.bbox.x0 - 30) < 0.6 && Math.abs(mv.bbox.y0 - g.bbox.y0 + 12) < 0.6, 'moved text lands exactly where dragged');
}
console.log(failures ? `\n${failures} FAILED` : '\nlayout passed');
process.exit(failures ? 1 : 0);
