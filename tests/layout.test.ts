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
console.log('\nnothing painted after the text may rub out an edit');
{
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const oc = await SourceDoc.open({ id: 's0', name: 'o', bytes: new Uint8Array(readFileSync('tests/fixtures/occlude.pdf')) });
  const g = oc.model(0).groups.find((x) => x.text.includes('ADAEZE'))!;
  const darkIn = (bytes: Uint8Array, r: { x0: number; y0: number; x1: number; y1: number }, name: string) => {
    writeFileSync(`tests/out/${name}.pdf`, bytes);
    execFileSync('pdftoppm', ['-r', '72', '-gray', '-singlefile', `tests/out/${name}.pdf`, `tests/out/${name}`]);
    const buf = readFileSync(`tests/out/${name}.pgm`);
    const hdr = buf.subarray(0, 20).toString('latin1').split(/\s+/);
    const W = +hdr[1], H = +hdr[2], off = buf.length - W * H;
    let n = 0;
    for (let y = Math.floor(300 - r.y1); y < Math.ceil(300 - r.y0); y++) for (let x = Math.floor(r.x0); x < Math.ceil(r.x1); x++) if (buf[off + y * W + x] < 90) n++;
    return n;
  };
  const build = async (e: TextEdit) => {
    const st = emptyState();
    st.pages = [{ key: 's0:0', rotate: 0 }];
    st.textEdits['s0:0'] = { [g.id]: e };
    return buildPdf(new Map([['s0', oc]]), 's0', st, new Map());
  };
  let hasPop = true;
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); } catch { hasPop = false; }
  if (hasPop) {
    // longer, still centred: the right end now reaches under the white panel
    const longer = await build({ text: 'OLUWAYEMISI ARIGBEDE ADEYEMI' });
    const panel = { x0: (600 + (g.bbox.x1 - g.bbox.x0)) / 2 + 8, y0: g.bbox.y0 + 2, x1: (600 + (g.bbox.x1 - g.bbox.x0)) / 2 + 120, y1: g.bbox.y1 - 2 };
    check(darkIn(longer, panel, 'occ_long') > 40, 'longer name is NOT rubbed out by the white panel painted after it');
    // bigger: the tops of the letters now reach the white rule painted after it
    const bigger = await build({ scale: 1.5 });
    const rule = { x0: g.bbox.x0 + 4, y0: 173.6, x1: g.bbox.x0 + 160, y1: 176.4 };
    check(darkIn(bigger, rule, 'occ_big') > 20, 'enlarged name is NOT cut by the white rule painted after it');
    const plain = await build({ text: 'ADA OKONKWO' });
    check(darkIn(plain, rule, 'occ_plain') === 0, 'a shorter name stays in place (no needless redraw on top)');
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nlayout passed');
process.exit(failures ? 1 : 0);
