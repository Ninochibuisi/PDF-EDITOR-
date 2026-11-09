/* Stress: for every line of every fixture, swap two of its own characters (always encodable),
   rebuild and verify pdf.js extracts the new text. */
import { readFileSync, readdirSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import './register-fonts.ts';
import { SourceDoc, buildPdf, planTextEdit } from '../src/engine/engine.ts';
import { emptyState } from '../src/engine/model.ts';
import { mul, type TextRun } from '../src/engine/interpreter.ts';

/** page text in reading order (rows top→bottom, glyph runs left→right) */
function visualText(runs: TextRun[]): string {
  const pts = runs.filter((r) => r.text.trim()).map((r) => { const m = mul(r.tm, r.ctm); return { r, x: m[4], y: m[5] }; });
  pts.sort((a, b) => (Math.abs(a.y - b.y) > 3 ? b.y - a.y : a.x - b.x));
  return pts.map((p) => p.r.text).join('').replace(/\s+/g, '');
}

let bad = 0;
for (const f of readdirSync('tests/fixtures').filter((x) => x.endsWith('.pdf'))) {
  const bytes = new Uint8Array(readFileSync('tests/fixtures/' + f));
  const src = await SourceDoc.open({ id: 's0', name: f, bytes });
  const pages = Math.min(src.pageCount, 6);
  let groups = 0, inplace = 0, ok = 0;
  const t0 = Date.now();
  for (let p = 0; p < pages; p++) {
    const st = emptyState();
    st.pages = [{ key: `s0:${p}`, rotate: 0 }];
    const m = src.model(p);
    const expect: string[] = [];
    for (const g of m.groups) {
      const t = g.text.trim();
      if (t.length < 4 || g.runs[0].Tr === 3) continue;
      groups++;
      // reverse the trimmed text: same glyph set, guaranteed encodable
      const nt = g.text.replace(t, [...t].reverse().join(''));
      const plan = planTextEdit(g, { text: nt });
      if (plan.mode !== 'inplace') { console.log(`   ${f} p${p} not inplace (${plan.missing.join('')}): ${t.slice(0, 40)}`); continue; }
      inplace++;
      (st.textEdits[`s0:${p}`] ??= {})[g.id] = { text: nt };
      expect.push([...t].reverse().join('').replace(/\s+/g, ''));
    }
    const out = await buildPdf(new Map([['s0', src]]), 's0', st, new Map());
    const doc = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    const re = await SourceDoc.open({ id: 'r', name: 'r', bytes: out });
    const all = (tc.items as { str: string }[]).map((i) => i.str).join('').replace(/\s+/g, '') + '\n' + re.model(0).groups.map((g) => g.text).join('').replace(/\s+/g, '') + '\n' + visualText(re.model(0).runs);
    for (const e of expect) {
      if (all.includes(e.slice(0, 30))) ok++;
      else { bad++; console.log(`   ✘ ${f} p${p} missing: ${e.slice(0, 50)}`); }
    }
  }
  console.log(`${f}: ${pages} pages, ${groups} lines, ${inplace} editable in original font, ${ok} verified (${Date.now() - t0} ms)`);
}
console.log(bad ? `${bad} FAILED` : 'stress passed');
process.exit(bad ? 1 : 0);
