import { readFileSync } from 'node:fs';
import { registerBundledFont } from '../src/engine/engine.ts';
for (const n of ['DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSerif', 'DejaVuSerif-Bold'])
  registerBundledFont(n, new Uint8Array(readFileSync(`src/assets/fonts/${n}.ttf`)));
