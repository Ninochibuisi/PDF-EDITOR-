import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, writeFileSync } from 'node:fs';

const d1 = await PDFDocument.create();
const p1 = d1.addPage([612, 792]);
const hv = await d1.embedFont(StandardFonts.Helvetica);
p1.drawText('Hello World from Helvetica', { x: 72, y: 700, size: 18, font: hv, color: rgb(0.1, 0.2, 0.7) });
p1.drawText('Second line stays put', { x: 72, y: 670, size: 12, font: hv });
writeFileSync('tests/fixtures/std.pdf', await d1.save());

const d2 = await PDFDocument.create();
d2.registerFontkit(fontkit);
const ttf = await d2.embedFont(readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'), { subset: true });
const p2 = d2.addPage([612, 792]);
p2.drawText('Invoice total: 1,250.00 USD', { x: 72, y: 700, size: 16, font: ttf });
p2.drawText('Thanks for your business', { x: 72, y: 660, size: 12, font: ttf });
writeFileSync('tests/fixtures/ttf.pdf', await d2.save());
console.log('fixtures ok');

// form + image fixture
{
  const d = await PDFDocument.create();
  const p = d.addPage([612, 792]);
  const f = await d.embedFont(StandardFonts.Helvetica);
  p.drawText('Application form', { x: 72, y: 720, size: 22, font: f });
  const form = d.getForm();
  const name = form.createTextField('applicant.name');
  name.addToPage(p, { x: 72, y: 640, width: 260, height: 24 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(p, { x: 72, y: 600, width: 16, height: 16 });
  const dd = form.createDropdown('country');
  dd.addOptions(['Nigeria', 'Ghana', 'Kenya']);
  dd.addToPage(p, { x: 72, y: 550, width: 160, height: 22 });
  // tiny generated PNG logo
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAJElEQVR4nGNgYGD4z8DAwMDEwMDw//9/BgYGBgYmBgYGBgYGAPkCBP8Zu7G3AAAAAElFTkSuQmCC', 'base64');
  const img = await d.embedPng(png);
  p.drawImage(img, { x: 400, y: 640, width: 120, height: 120 });
  writeFileSync('tests/fixtures/form.pdf', await d.save());
}
console.log('form fixture ok');

// colour / transparency fixture
{
  const d = await PDFDocument.create();
  const p = d.addPage([612, 792]);
  const f = await d.embedFont(StandardFonts.TimesRoman);
  p.drawRectangle({ x: 60, y: 560, width: 500, height: 120, color: rgb(0.85, 0.93, 1) });
  p.drawText('Semi transparent crimson headline', { x: 72, y: 640, size: 26, font: f, color: rgb(0.8, 0.1, 0.3), opacity: 0.6 });
  p.drawText('Teal body copy that must keep its exact shade', { x: 72, y: 600, size: 14, font: f, color: rgb(0.05, 0.5, 0.5) });
  p.drawText('Untouched reference line', { x: 72, y: 520, size: 14, font: f, color: rgb(0.3, 0.3, 0.3) });
  writeFileSync('tests/fixtures/color.pdf', await d.save());
}
// untagged watermark fixture (what most tools produce)
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const fb = await d.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < 3; i++) {
    const p = d.addPage([612, 792]);
    p.drawText(`Page ${i + 1} body text of the contract.`, { x: 72, y: 700, size: 12, font: f });
    p.drawText('CONFIDENTIAL', { x: 150, y: 300, size: 64, font: fb, color: rgb(0.6, 0.6, 0.6), opacity: 0.3, rotate: degrees(45) });
  }
  writeFileSync('tests/fixtures/watermarked.pdf', await d.save());
}
console.log('quality fixtures ok');

// Type0 font with currency symbols and NO ToUnicode map (symbols must decode from the font program itself)
{
  const { PDFName } = await import('pdf-lib');
  const d = await PDFDocument.create();
  d.registerFontkit(fontkit);
  const f = await d.embedFont(readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'), { subset: false });
  const p = d.addPage([612, 792]);
  p.drawText('Amount ₦5,000 or $12 or €9', { x: 72, y: 700, size: 16, font: f });
  await d.flush();
  for (const [, obj] of d.context.enumerateIndirectObjects()) {
    const dict = (obj as { get?: (n: unknown) => unknown; delete?: (n: unknown) => void });
    if (dict.get && dict.delete && String(dict.get(PDFName.of('Subtype'))) === '/Type0') dict.delete(PDFName.of('ToUnicode'));
  }
  writeFileSync('tests/fixtures/notounicode.pdf', await d.save());
}
console.log('symbol fixtures ok');

// certificate: centred title/name, right-aligned date, left-aligned body
{
  const d = await PDFDocument.create();
  const p = d.addPage([842, 595]);
  const hb = await d.embedFont(StandardFonts.HelveticaBold);
  const hv = await d.embedFont(StandardFonts.Helvetica);
  const centre = (t: string, y: number, size: number, f = hv) => p.drawText(t, { x: (842 - f.widthOfTextAtSize(t, size)) / 2, y, size, font: f });
  centre('CERTIFICATE OF COMPLETION', 470, 30, hb);
  centre('This certifies that', 420, 14);
  centre('ADAEZE OKONKWO', 370, 28, hb);
  p.drawLine({ start: { x: 271, y: 360 }, end: { x: 571, y: 360 }, thickness: 1, color: rgb(0.6, 0.6, 0.6) });
  centre('has successfully completed the Advanced PDF Engineering programme', 330, 13);
  const date = 'Lagos, 12 November 2026';
  p.drawText(date, { x: 770 - hv.widthOfTextAtSize(date, 12), y: 120, size: 12, font: hv });
  p.drawText('Signed: Registrar', { x: 770 - hv.widthOfTextAtSize('Signed: Registrar', 12), y: 100, size: 12, font: hv });
  p.drawText('Reference: CERT-2026-0042', { x: 72, y: 120, size: 12, font: hv });
  p.drawText('Verify at example.org/verify', { x: 72, y: 100, size: 12, font: hv });
  writeFileSync('tests/fixtures/certificate.pdf', await d.save());
}
console.log('layout fixture ok');
