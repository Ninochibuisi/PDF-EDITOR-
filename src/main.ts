import './ui/styles.css';
import * as pdfjs from 'pdfjs-dist';
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { App } from './ui/app.ts';

// The pdf.js worker is bundled into this single file and spun up from a Blob URL,
// so the app runs fully offline from one HTML file.
pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));

const app = new App(document.getElementById('app')!);
(window as unknown as { app: App }).app = app;
