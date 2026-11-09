import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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
