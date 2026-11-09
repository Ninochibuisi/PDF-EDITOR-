import './ui/styles.css';
import * as pdfjs from 'pdfjs-dist';
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { App } from './ui/app.ts';
import { registerBundledFont } from './engine/engine.ts';
import sans from './assets/fonts/DejaVuSans.ttf?inline';
import sansBold from './assets/fonts/DejaVuSans-Bold.ttf?inline';
import serif from './assets/fonts/DejaVuSerif.ttf?inline';
import serifBold from './assets/fonts/DejaVuSerif-Bold.ttf?inline';

// Unicode fallback fonts (currency & symbols such as ₦ ₵ ₹ that the standard PDF fonts can't draw).
// Used only for characters that are missing from every font embedded in the document.
const fromDataUrl = (u: string) => Uint8Array.from(atob(u.slice(u.indexOf(',') + 1)), (c) => c.charCodeAt(0));
registerBundledFont('DejaVuSans', fromDataUrl(sans));
registerBundledFont('DejaVuSans-Bold', fromDataUrl(sansBold));
registerBundledFont('DejaVuSerif', fromDataUrl(serif));
registerBundledFont('DejaVuSerif-Bold', fromDataUrl(serifBold));

// The pdf.js worker is bundled into this single file and spun up from a Blob URL,
// so the app runs fully offline from one HTML file.
pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));

const app = new App(document.getElementById('app')!);
(window as unknown as { app: App }).app = app;
