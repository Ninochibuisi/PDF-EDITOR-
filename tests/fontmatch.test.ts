/* Automatic font matching: font names map to the right open fonts / metric twins. */
import { candidatesFor, parseFontName } from '../src/ui/fontmatch.ts';
let failures = 0;
const check = (c: boolean, m: string) => { console.log(`${c ? '  ✔' : '  ✘'} ${m}`); if (!c) failures++; };
const ids = (n: string) => candidatesFor(n).map((c) => c.id).join(' > ');
const cases: [string, string, number, boolean][] = [
  ['AAAAAA+Roboto-Medium', 'roboto', 500, false], ['OpenSans-SemiBoldItalic', 'open-sans', 600, true], ['BCDEFG+Inter-Bold', 'inter', 700, false],
  ['ArialMT', 'arial > arimo', 400, false], ['Arial-BoldMT', 'arial > arimo', 700, false], ['TimesNewRomanPSMT', 'times-new-roman > tinos', 400, false], ['TimesNewRomanPS-BoldMT', 'times-new-roman > tinos', 700, false],
  ['Calibri-Bold', 'calibri > carlito', 700, false], ['CAAAAA+LiberationSans', 'arimo', 400, false], ['Poppins-Light', 'poppins', 300, false],
  ['Montserrat-ExtraBold', 'montserrat', 800, false], ['Times-Roman', 'times-roman > tinos', 400, false], ['SegoeUI', 'segoe-ui > open-sans', 400, false],
];
for (const [n, want, w, it] of cases) {
  const p = parseFontName(n);
  check(ids(n) === want && p.weight === w && p.italic === it, `${n.padEnd(26)} → ${ids(n)} (weight ${p.weight}${p.italic ? ', italic' : ''})`);
}
console.log(failures ? `\n${failures} FAILED` : '\nfontmatch passed');
process.exit(failures ? 1 : 0);
