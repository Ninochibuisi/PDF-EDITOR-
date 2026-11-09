/* Stress: for every line of every fixture, swap two of its own characters (always encodable),
   rebuild and verify pdf.js extracts the new text. */
import { readFileSync, readdirSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { SourceDoc, buildPdf, planTextEdit } from '../src/engine/engine.ts';
import { emptyState } from '../src/engine/model.ts';

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
    const doc = await pdfjs.getDocument({ data: out, verbosity: 0 }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    const all = (tc.items as { str: string }[]).map((i) => i.str).join('').replace(/\s+/g, '');
    for (const e of expect) {
      if (all.includes(e.slice(0, 30))) ok++;
      else { bad++; console.log(`   ✘ ${f} p${p} missing: ${e.slice(0, 50)}`); }
    }
  }
  console.log(`${f}: ${pages} pages, ${groups} lines, ${inplace} editable in original font, ${ok} verified (${Date.now() - t0} ms)`);
}
console.log(bad ? `${bad} FAILED` : 'stress passed');
process.exit(bad ? 1 : 0);
