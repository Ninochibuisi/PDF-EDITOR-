import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { Encodings, Font as StdFont, type IFontNames } from '@pdf-lib/standard-fonts';
import { downloadMatch, prettyName, editorFontFamily, cssWeight } from './fontmatch.ts';
import { scanDocument, type ScanReport, type DetectedWatermark } from '../engine/watermarks.ts';
import { fallbackPrefs, SourceDoc, buildPdf, planTextEdit, listFields, unsupportedStandardChars, uprightFrame, STANDARD_FONT_NAMES, type FieldInfo } from '../engine/engine.ts';
import type { TextGroup, XObjectRun, FillColor } from '../engine/interpreter.ts';
import { emptyState, uid, type Asset, type EditorState, type Overlay, type PageSlot, type RGB, type TextEdit, type TextOverlay, type Watermark, type WatermarkPosition } from '../engine/model.ts';
import { h, icon, toast, pickFiles, download, hexToRgb, rgbToHex } from './dom.ts';

type Tool = 'select' | 'edittext' | 'objects' | 'text' | 'image' | 'sign' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'ink' | 'highlight' | 'whiteout' | 'redact';
type Selection = { kind: 'text' | 'obj' | 'ov'; key: string; id: string } | null;

interface PageView {
  index: number;
  slot: PageSlot;
  el: HTMLDivElement;
  layer: HTMLDivElement;
  canvas?: HTMLCanvasElement;
  page?: PDFPageProxy;
  vp?: PageViewport;
  renderedGen: number;
  renderedZoom: number;
  visible: boolean;
  thumb: HTMLDivElement;
  thumbGen: number;
}

const TOOLS: { id: Tool; icon: string; tip: string; key?: string }[] = [
  { id: 'select', icon: 'pointer', tip: 'Select & move annotations (V)', key: 'v' },
  { id: 'edittext', icon: 'edittext', tip: 'Edit existing text (E)', key: 'e' },
  { id: 'objects', icon: 'objects', tip: 'Edit images & objects (O)', key: 'o' },
  { id: 'text', icon: 'text', tip: 'Add text (T)', key: 't' },
  { id: 'image', icon: 'image', tip: 'Add image (I)', key: 'i' },
  { id: 'sign', icon: 'sign', tip: 'Signature (S)', key: 's' },
  { id: 'rect', icon: 'rect', tip: 'Rectangle (R)', key: 'r' },
  { id: 'ellipse', icon: 'ellipse', tip: 'Ellipse', key: 'c' },
  { id: 'line', icon: 'line', tip: 'Line (L)', key: 'l' },
  { id: 'arrow', icon: 'arrow', tip: 'Arrow (A)', key: 'a' },
  { id: 'ink', icon: 'ink', tip: 'Freehand draw (D)', key: 'd' },
  { id: 'highlight', icon: 'highlight', tip: 'Highlight (H) – click a line or drag', key: 'h' },
  { id: 'whiteout', icon: 'whiteout', tip: 'Whiteout (W)', key: 'w' },
  { id: 'redact', icon: 'redact', tip: 'Redact – permanently removes content (X)', key: 'x' },
];

const SEP_AFTER: Tool[] = ['objects', 'sign', 'ink'];

export class App {
  root: HTMLElement;
  sources = new Map<string, SourceDoc>();
  primaryId = '';
  assets = new Map<string, Asset>();
  state: EditorState = emptyState();
  undoStack: string[] = [];
  redoStack: string[] = [];
  tool: Tool = 'edittext';
  zoom = 1;
  fileName = 'document.pdf';
  built?: PDFDocumentProxy;
  builtBytes?: Uint8Array;
  buildGen = 0;
  buildTimer = 0;
  views: PageView[] = [];
  selection: Selection = null;
  currentPage = 0;
  tab: 'props' | 'find' | 'wm' | 'forms' | 'doc' = 'props';
  report?: ScanReport;
  autoFonts = (() => { try { return localStorage.getItem('dpe.autoFonts') !== '0'; } catch { return true; } })();
  private autoMatched = new Set<string>();
  private fontJobs = new Map<string, Promise<'new' | 'failed' | 'none'>>();
  private fontFailed = new Set<string>();
  fontPending = new Set<string>();
  scanning = false;
  wmOpen: string | null = null;
  fields: FieldInfo[] = [];
  style = { stroke: [0.86, 0.15, 0.27] as RGB, fill: null as RGB | null, lineWidth: 2, textColor: [0.07, 0.07, 0.1] as RGB, fontSize: 14, font: 'Helvetica', highlight: [1, 0.85, 0.1] as RGB, opacity: 1 };
  findQuery = '';
  replaceText = '';
  findCase = false;
  private io?: IntersectionObserver;
  private thumbIo?: IntersectionObserver;
  private dragSlot = -1;
  private editing = false;

  // dom
  topbar!: HTMLElement;
  toolsEl!: HTMLElement;
  thumbsEl!: HTMLElement;
  viewer!: HTMLElement;
  pagesEl!: HTMLElement;
  inspector!: HTMLElement;
  tabbody!: HTMLElement;
  statusEl!: HTMLElement;
  zoomLabel!: HTMLElement;
  undoBtn!: HTMLButtonElement;
  redoBtn!: HTMLButtonElement;
  docNameEl!: HTMLElement;
  busyDot!: HTMLElement;
  statusText!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.renderShell();
    this.bindGlobal();
    this.showEmpty();
  }

  // =====================================================================
  // shell
  // =====================================================================
  renderShell() {
    this.docNameEl = h('span', { class: 'docname' });
    this.zoomLabel = h('span', { class: 'zoom' }, '100%');
    this.undoBtn = h('button', { class: 'btn icon', title: 'Undo (Ctrl+Z)', onclick: () => this.undo() }, icon('undo'));
    this.redoBtn = h('button', { class: 'btn icon', title: 'Redo (Ctrl+Shift+Z)', onclick: () => this.redo() }, icon('redo'));
    this.topbar = h('div', { class: 'topbar' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('file')), 'Deep PDF Editor', h('small', {}, 'local · private')),
      this.docNameEl,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => this.openDialog() }, icon('open'), 'Open'),
      h('button', { class: 'btn', title: 'Insert pages from PDFs, images or text files', onclick: () => this.insertDialog() }, icon('plus'), 'Insert'),
      h('div', { class: 'sep' }),
      this.undoBtn, this.redoBtn,
      h('div', { class: 'sep' }),
      h('button', { class: 'btn icon', title: 'Zoom out (-)', onclick: () => this.setZoom(this.zoom / 1.2) }, icon('minus')),
      this.zoomLabel,
      h('button', { class: 'btn icon', title: 'Zoom in (+)', onclick: () => this.setZoom(this.zoom * 1.2) }, icon('plus')),
      h('button', { class: 'btn icon', title: 'Fit width', onclick: () => this.fitWidth() }, icon('fit')),
      h('div', { class: 'sep' }),
      h('button', { class: 'btn primary', title: 'Export PDF (Ctrl+S)', onclick: () => this.exportPdf('lossless') }, icon('save'), 'Export PDF'),
    );
    this.toolsEl = h('div', { class: 'tools' });
    for (const t of TOOLS) {
      const b = h('button', { class: 'tool', 'data-tool': t.id, onclick: () => this.setTool(t.id) }, icon(t.icon), h('span', { class: 'tip' }, t.tip));
      this.toolsEl.appendChild(b);
      if (SEP_AFTER.includes(t.id)) this.toolsEl.appendChild(h('hr'));
    }
    this.thumbsEl = h('div', { class: 'thumbs' });
    this.pagesEl = h('div', { class: 'pages' });
    this.viewer = h('div', { class: 'viewer' }, this.pagesEl);
    this.tabbody = h('div', { class: 'tabbody' });
    this.inspector = h('div', { class: 'inspector' }, h('div', { class: 'tabs' }), this.tabbody);
    this.busyDot = h('span', { class: 'dot' });
    this.statusText = h('span', {}, 'Ready');
    this.statusEl = h('div', { class: 'statusbar' }, h('span', {}, this.busyDot, this.statusText), h('span', { class: 'pageinfo' }), h('div', { class: 'spacer' }), h('span', {}, '🔒 Everything runs in your browser — files never leave this device'));
    this.root.append(this.topbar, h('div', { class: 'main' }, this.toolsEl, this.thumbsEl, this.viewer, this.inspector), this.statusEl);
    this.setTool(this.tool);
    this.renderTabs();
    this.viewer.addEventListener('scroll', () => this.updateCurrentPage(), { passive: true });
    this.viewer.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      }
    }, { passive: false });
  }

  showEmpty() {
    const drop = h('div', { class: 'drop' },
      h('div', { class: 'brand', style: 'justify-content:center' }, h('div', { class: 'logo', style: 'width:44px;height:44px;border-radius:12px' }, icon('file'))),
      h('h1', {}, 'Edit any PDF. Keep every font.'),
      h('p', {}, 'Drop a PDF, image or text file here. The text you change is re-encoded with the document\'s own embedded fonts, so the result looks like it was never touched.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn primary', onclick: () => this.openDialog() }, icon('open'), 'Open file'),
        h('button', { class: 'btn', onclick: () => this.newBlank() }, icon('blank'), 'New blank document'),
      ),
      h('div', { class: 'feats' },
        h('div', { class: 'feat' }, h('b', {}, 'True text editing'), 'Rewrites the content stream in the original font. Reflows the line.'),
        h('div', { class: 'feat' }, h('b', {}, 'Real redaction'), 'Removes glyphs & images under the box, not just covers them.'),
        h('div', { class: 'feat' }, h('b', {}, 'Pages'), 'Merge, reorder, rotate, delete, insert blanks & images.'),
        h('div', { class: 'feat' }, h('b', {}, 'Annotate & sign'), 'Text, shapes, ink, highlights, images, signatures.'),
        h('div', { class: 'feat' }, h('b', {}, 'Forms'), 'Fill & flatten AcroForm fields.'),
        h('div', { class: 'feat' }, h('b', {}, 'Find & replace'), 'Across the whole document, in place.'),
      ),
    );
    const wrap = h('div', { class: 'empty' }, drop);
    this.viewer.appendChild(wrap);
    const over = (on: boolean) => drop.classList.toggle('over', on);
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); over(true); });
    wrap.addEventListener('dragleave', () => over(false));
    wrap.addEventListener('drop', () => over(false));
  }

  bindGlobal() {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      if (this.primaryId) this.insertFiles(files);
      else this.openFiles(files);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('beforeunload', (e) => {
      if (this.undoStack.length) e.preventDefault();
    });
  }

  onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const typing = t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.exportPdf('lossless'); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openDialog(); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); this.tab = 'find'; this.renderTabs(); (this.tabbody.querySelector('input') as HTMLInputElement)?.focus(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (this.selection) { e.preventDefault(); this.deleteSelection(); } return; }
    if (e.key === 'Escape') { this.select(null); return; }
    if (e.key === '+' || e.key === '=') { this.setZoom(this.zoom * 1.2); return; }
    if (e.key === '-') { this.setZoom(this.zoom / 1.2); return; }
    if (!mod && !e.altKey) {
      const tool = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (tool && this.primaryId) this.setTool(tool.id);
    }
  }

  setStatus(text: string, busy = false) {
    this.statusText.textContent = text;
    this.busyDot.classList.toggle('busy', busy);
  }

  // =====================================================================
  // document lifecycle
  // =====================================================================
  async openDialog() {
    const files = await pickFiles('.pdf,application/pdf,image/png,image/jpeg,.txt,text/plain');
    if (files.length) this.openFiles(files);
  }

  async insertDialog() {
    if (!this.primaryId) return this.openDialog();
    const files = await pickFiles('.pdf,application/pdf,image/png,image/jpeg,.txt,text/plain', true);
    if (files.length) this.insertFiles(files);
  }

  async newBlank() {
    const d = await PDFDocument.create();
    d.addPage([595.28, 841.89]);
    await this.loadPrimary(await d.save(), 'untitled.pdf');
  }

  async openFiles(files: File[]) {
    const f = files[0];
    try {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        await this.loadPrimary(new Uint8Array(await f.arrayBuffer()), f.name);
        if (files.length > 1) await this.insertFiles(files.slice(1));
      } else {
        const d = await PDFDocument.create();
        await this.loadPrimary(await d.save(), f.name.replace(/\.[^.]+$/, '') + '.pdf', true);
        await this.insertFiles(files, true);
      }
    } catch (e) {
      console.error(e);
      toast('Could not open this file: ' + (e as Error).message, true, 5000);
    }
  }

  async loadPrimary(bytes: Uint8Array, name: string, empty = false) {
    this.setStatus('Parsing…', true);
    const src = await SourceDoc.open({ id: 's0', name, bytes });
    this.sources = new Map([['s0', src]]);
    this.primaryId = 's0';
    this.assets = new Map();
    this.fileName = name;
    this.state = emptyState();
    this.state.pages = empty ? [] : Array.from({ length: src.pageCount }, (_, i) => ({ key: `s0:${i}`, rotate: 0 }));
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.views = [];
    this.fields = listFields(src.doc);
    this.docNameEl.textContent = name;
    document.title = `${name} · Deep PDF Editor`;
    this.viewer.querySelector('.empty')?.remove();
    if (src.encrypted) toast('This PDF is encrypted. Viewing works, but edits to encrypted content may not apply.', true, 6000);
    this.zoom = 1;
    this.report = undefined;
    await this.rebuild(true);
    this.fitWidth();
    this.renderTabs();
    this.smartScan();
  }

  /** Analyse every page in the background (fonts, text lines, images, watermarks, scanned pages). */
  async smartScan() {
    if (this.scanning) return;
    this.scanning = true;
    const todo = this.state.pages.map((p) => this.sourceOf(p.key)).filter((x): x is { src: SourceDoc; index: number } => !!x);
    for (let k = 0; k < todo.length; k++) {
      todo[k].src.model(todo[k].index);
      if (k % 4 === 3) {
        this.setStatus(`Smart scan ${k + 1}/${todo.length}…`, true);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.scanning = false;
    this.computeReport();
    const n = this.report!.watermarks.length;
    this.setStatus(`Smart scan complete · ${this.state.pages.length} pages`);
    if (n) toast(`Smart scan found ${n} watermark${n > 1 ? 's' : ''} – see the Watermarks tab`, false, 4000);
    this.renderTabs();
  }

  computeReport() {
    const infos = this.state.pages.flatMap((p, i) => {
      const s = this.sourceOf(p.key);
      if (!s) return [];
      const ps = s.src.pageSize(s.index);
      return [{ key: p.key, number: i + 1, model: s.src.model(s.index), box: ps.box }];
    });
    this.report = scanDocument(infos);
  }

  async insertFiles(files: File[], silent = false) {
    let at = this.state.pages.length ? Math.min(this.currentPage + 1, this.state.pages.length) : 0;
    const before = this.snapshot();
    const newPages: PageSlot[] = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        const id = 's' + this.sources.size + uid('');
        const src = await SourceDoc.open({ id, name: f.name, bytes });
        this.sources.set(id, src);
        for (let i = 0; i < src.pageCount; i++) newPages.push({ key: `${id}:${i}`, rotate: 0 });
      } else if (/^image\/(png|jpeg)$/.test(f.type) || /\.(png|jpe?g)$/i.test(f.name)) {
        const kind = /png/i.test(f.type) || /\.png$/i.test(f.name) ? 'png' : 'jpg';
        const asset: Asset = { id: uid('a'), kind, name: f.name, bytes };
        this.assets.set(asset.id, asset);
        const { w, h: hh } = await imageSize(bytes, kind);
        // fit inside A4 at 72dpi, keep aspect
        const s = Math.min(1, 595 / (w * 0.75), 842 / (hh * 0.75));
        const pw = Math.max(36, w * 0.75 * s), ph = Math.max(36, hh * 0.75 * s);
        const key = 'blank:' + uid('p');
        newPages.push({ key, rotate: 0, size: [pw, ph] });
        this.state.overlays[key] = [{ id: uid('o'), type: 'image', asset: asset.id, x: 0, y: 0, w: pw, h: ph, rot: 0 }];
      } else if (/\.txt$/i.test(f.name) || f.type.startsWith('text/')) {
        const text = new TextDecoder().decode(bytes);
        const lines: string[] = [];
        for (const raw of text.replace(/\r/g, '').split('\n')) {
          let l = raw.replace(/\t/g, '    ');
          if (!l) lines.push('');
          while (l.length) { lines.push(l.slice(0, 92)); l = l.slice(92); }
        }
        for (let i = 0; i < Math.max(1, lines.length); i += 64) {
          const key = 'blank:' + uid('p');
          newPages.push({ key, rotate: 0, size: [595.28, 841.89] });
          this.state.overlays[key] = [{ id: uid('o'), type: 'text', text: lines.slice(i, i + 64).join('\n'), x: 48, y: 48, w: 500, h: 745, rot: 0, size: 9.5, color: [0, 0, 0], font: 'Courier' }];
        }
      } else {
        toast(`Unsupported file: ${f.name}`, true);
      }
    }
    if (!newPages.length) return;
    this.pushUndo(before);
    this.state.pages.splice(at, 0, ...newPages);
    if (!silent) toast(`Inserted ${newPages.length} page${newPages.length > 1 ? 's' : ''}`);
    await this.rebuild(true);
    this.scrollToPage(at);
    this.smartScan();
    at += newPages.length;
  }

  // =====================================================================
  // state + history
  // =====================================================================
  snapshot() {
    return JSON.stringify(this.state);
  }
  pushUndo(snap: string) {
    this.undoStack.push(snap);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.updateHistoryButtons();
  }
  commit(fn: (s: EditorState) => void, opts: { structural?: boolean } = {}) {
    const before = this.snapshot();
    fn(this.state);
    if (this.snapshot() === before) return;
    this.pushUndo(before);
    this.scheduleBuild(opts.structural);
    this.renderTabs();
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.state = JSON.parse(s);
    this.afterHistory();
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.state = JSON.parse(s);
    this.afterHistory();
  }
  afterHistory() {
    this.selection = null;
    this.updateHistoryButtons();
    this.scheduleBuild(true);
    this.renderTabs();
  }
  updateHistoryButtons() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  // =====================================================================
  // build + render pipeline
  // =====================================================================
  scheduleBuild(structural = false) {
    clearTimeout(this.buildTimer);
    this.buildTimer = window.setTimeout(() => this.rebuild(structural), 60);
  }

  async rebuild(structural = false) {
    if (!this.primaryId) return;
    const gen = ++this.buildGen;
    this.setStatus('Applying edits…', true);
    let bytes: Uint8Array;
    try {
      bytes = await buildPdf(this.sources, this.primaryId, this.state, this.assets);
    } catch (e) {
      console.error(e);
      this.setStatus('Build failed: ' + (e as Error).message);
      toast('Could not apply edit: ' + (e as Error).message, true, 5000);
      return;
    }
    if (gen !== this.buildGen) return;
    const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
    if (gen !== this.buildGen) {
      doc.destroy();
      return;
    }
    const old = this.built;
    this.built = doc;
    this.builtBytes = bytes;
    await this.layout(structural);
    this.autoMatchEdits();
    this.setStatus(`${this.state.pages.length} page${this.state.pages.length === 1 ? '' : 's'} · ${(bytes.length / 1024).toFixed(0)} KB`);
    setTimeout(() => old?.destroy(), 1500);
  }

  async layout(structural: boolean) {
    const doc = this.built!;
    const n = this.state.pages.length;
    const keysChanged = this.views.length !== n || this.views.some((v, i) => v.slot.key !== this.state.pages[i].key);
    if (structural || keysChanged) this.createViews();
    for (const v of this.views) {
      v.slot = this.state.pages[v.index];
      v.page = await doc.getPage(v.index + 1);
      v.vp = v.page.getViewport({ scale: this.zoom });
      v.el.style.width = v.vp.width + 'px';
      v.el.style.height = v.vp.height + 'px';
      this.drawLayer(v);
    }
    for (const v of this.views) if (v.visible) this.renderPage(v);
    for (const v of this.views) this.renderThumb(v);
    this.updatePageInfo();
  }

  createViews() {
    this.io?.disconnect();
    this.thumbIo?.disconnect();
    this.pagesEl.innerHTML = '';
    this.thumbsEl.innerHTML = '';
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = this.views.find((x) => x.el === e.target);
        if (!v) continue;
        v.visible = e.isIntersecting;
        if (v.visible) this.renderPage(v);
      }
    }, { root: this.viewer, rootMargin: '800px 0px' });
    this.views = this.state.pages.map((slot, index) => {
      const layer = h('div', { class: 'layer' });
      const el = h('div', { class: 'page' }, h('div', { class: 'plabel' }, `Page ${index + 1}`), layer);
      this.pagesEl.appendChild(el);
      const thumb = this.makeThumb(index);
      const v: PageView = { index, slot, el, layer, renderedGen: -1, renderedZoom: 0, visible: false, thumb, thumbGen: -1 };
      this.bindLayer(v);
      this.io!.observe(el);
      return v;
    });
    this.thumbIo = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) {
        const v = this.views.find((x) => x.thumb === e.target);
        if (v) this.renderThumb(v, true);
      }
    }, { root: this.thumbsEl, rootMargin: '300px 0px' });
    for (const v of this.views) this.thumbIo.observe(v.thumb);
  }

  async renderPage(v: PageView) {
    if (!v.page || !v.vp) return;
    const gen = this.buildGen;
    if (v.renderedGen === gen && v.renderedZoom === this.zoom) return;
    v.renderedGen = gen;
    v.renderedZoom = this.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = v.page.getViewport({ scale: this.zoom * dpr });
    const c = h('canvas', { class: 'render' });
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    try {
      await v.page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    } catch {
      return;
    }
    if (v.renderedGen !== gen) return;
    if (v.canvas) v.canvas.replaceWith(c);
    else v.el.insertBefore(c, v.layer);
    v.canvas = c;
  }

  makeThumb(index: number): HTMLDivElement {
    const t = h('div', { class: 'thumb', draggable: true },
      h('div', { class: 'ph' }),
      h('div', { class: 'num' }, String(index + 1)),
      h('div', { class: 'acts' },
        h('button', { title: 'Rotate left', onclick: (e: Event) => { e.stopPropagation(); this.rotatePage(index, -90); } }, icon('rotatel')),
        h('button', { title: 'Rotate right', onclick: (e: Event) => { e.stopPropagation(); this.rotatePage(index, 90); } }, icon('rotate')),
        h('button', { title: 'Insert blank page after', onclick: (e: Event) => { e.stopPropagation(); this.insertBlank(index); } }, icon('blank')),
        h('button', { title: 'Delete page', onclick: (e: Event) => { e.stopPropagation(); this.deletePage(index); } }, icon('trash')),
      ),
    );
    t.addEventListener('click', () => this.scrollToPage(index));
    t.addEventListener('dragstart', (e) => { this.dragSlot = index; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', String(index)); });
    t.addEventListener('dragover', (e) => { if (this.dragSlot >= 0) { e.preventDefault(); e.stopPropagation(); t.classList.add('dragover'); } });
    t.addEventListener('dragleave', () => t.classList.remove('dragover'));
    t.addEventListener('drop', (e) => {
      t.classList.remove('dragover');
      if (this.dragSlot < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const from = this.dragSlot;
      this.dragSlot = -1;
      if (from === index) return;
      this.commit((s) => {
        const [p] = s.pages.splice(from, 1);
        s.pages.splice(index, 0, p);
      }, { structural: true });
    });
    t.addEventListener('dragend', () => (this.dragSlot = -1));
    this.thumbsEl.appendChild(t);
    return t;
  }

  async renderThumb(v: PageView, force = false) {
    if (!v.page) return;
    if (v.thumbGen === this.buildGen) return;
    const r = v.thumb.getBoundingClientRect();
    const tr = this.thumbsEl.getBoundingClientRect();
    if (!force && (r.bottom < tr.top - 300 || r.top > tr.bottom + 300)) return;
    v.thumbGen = this.buildGen;
    const vp0 = v.page.getViewport({ scale: 1 });
    const vp = v.page.getViewport({ scale: 260 / vp0.width });
    const c = h('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    try {
      await v.page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    } catch {
      return;
    }
    v.thumb.firstElementChild?.replaceWith(c);
  }

  setZoom(z: number) {
    if (!this.built) return;
    const prevTop = this.viewer.scrollTop / Math.max(1, this.viewer.scrollHeight);
    this.zoom = Math.max(0.25, Math.min(5, z));
    this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
    this.layout(false).then(() => {
      this.viewer.scrollTop = prevTop * this.viewer.scrollHeight;
    });
  }

  fitWidth() {
    if (!this.views.length || !this.views[0].page) return;
    const vp = this.views[0].page.getViewport({ scale: 1 });
    this.setZoom((this.viewer.clientWidth - 60) / vp.width);
  }

  scrollToPage(i: number) {
    const v = this.views[i];
    if (v) this.viewer.scrollTo({ top: v.el.offsetTop - 20, behavior: 'smooth' });
    this.currentPage = i;
    this.updatePageInfo();
  }

  updateCurrentPage() {
    const mid = this.viewer.scrollTop + this.viewer.clientHeight / 3;
    let cur = 0;
    for (const v of this.views) if (v.el.offsetTop <= mid) cur = v.index;
    if (cur !== this.currentPage) {
      this.currentPage = cur;
      this.updatePageInfo();
    }
  }

  updatePageInfo() {
    const el = this.statusEl.querySelector('.pageinfo')!;
    el.textContent = this.views.length ? `Page ${this.currentPage + 1} / ${this.views.length} · ${Math.round(this.zoom * 100)}%` : '';
    this.views.forEach((v) => v.thumb.classList.toggle('current', v.index === this.currentPage));
    this.views.forEach((v) => {
      const n = v.thumb.querySelector('.num');
      if (n) n.textContent = String(v.index + 1);
    });
  }

  // =====================================================================
  // page operations
  // =====================================================================
  rotatePage(i: number, d: number) {
    this.commit((s) => { s.pages[i].rotate = (((s.pages[i].rotate + d) % 360) + 360) % 360; });
  }
  deletePage(i: number) {
    if (this.state.pages.length <= 1) return toast('A document needs at least one page', true);
    this.commit((s) => { s.pages.splice(i, 1); }, { structural: true });
  }
  insertBlank(i: number) {
    const v = this.views[i];
    let size: [number, number] = [595.28, 841.89];
    if (v?.page) {
      const [x0, y0, x1, y1] = v.page.view;
      size = [x1 - x0, y1 - y0];
    }
    this.commit((s) => { s.pages.splice(i + 1, 0, { key: 'blank:' + uid('p'), rotate: 0, size }); }, { structural: true });
  }

  // =====================================================================
  // coordinate helpers
  // =====================================================================
  toPx(v: PageView, x: number, y: number): [number, number] {
    return v.vp!.convertToViewportPoint(x, y) as [number, number];
  }
  toPdf(v: PageView, px: number, py: number): [number, number] {
    return v.vp!.convertToPdfPoint(px, py) as [number, number];
  }
  rectPx(v: PageView, x0: number, y0: number, x1: number, y1: number) {
    const a = this.toPx(v, x0, y0), b = this.toPx(v, x1, y1);
    return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
  }
  pxRectToPdf(v: PageView, l: number, t: number, w: number, hh: number) {
    const a = this.toPdf(v, l, t), b = this.toPdf(v, l + w, t + hh);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  }
  localPoint(v: PageView, e: PointerEvent | MouseEvent): [number, number] {
    const r = v.layer.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  totalRotation(v: PageView) {
    return v.page?.rotate ?? 0;
  }

  /** fonts of the document a page belongs to (lets edits borrow glyphs from same-face subsets) */
  fontPool(key: string) {
    return this.sourceOf(key)?.src.fonts.all() ?? [];
  }

  sourceOf(key: string): { src: SourceDoc; index: number } | undefined {
    if (key.startsWith('blank:')) return undefined;
    const [sid, idx] = key.split(':');
    const src = this.sources.get(sid);
    return src ? { src, index: Number(idx) } : undefined;
  }
  groupsOf(key: string): TextGroup[] {
    const s = this.sourceOf(key);
    return s ? s.src.model(s.index).groups : [];
  }
  xobjectsOf(key: string): XObjectRun[] {
    const s = this.sourceOf(key);
    return s ? s.src.model(s.index).xobjects : [];
  }

  // =====================================================================
  // layer: hit boxes for text, objects, overlays
  // =====================================================================
  drawLayer(v: PageView) {
    if (!v.vp || this.editing) return;
    const L = v.layer;
    L.innerHTML = '';
    const key = v.slot.key;
    // text groups
    if (this.tool === 'edittext' || this.tool === 'highlight' || this.tool === 'redact' || this.tool === 'whiteout') {
      const edits = this.state.textEdits[key] ?? {};
      const removed = new Set(this.state.removals[key] ?? []);
      for (const g of this.groupsOf(key)) {
        if (removed.has('group:' + g.id) || (g.runs[0].wm && removed.has(g.runs[0].wm))) continue;
        const e = edits[g.id];
        if (e?.deleted && this.tool !== 'edittext') continue;
        const dx = e?.dx ?? 0, dy = e?.dy ?? 0;
        const r = this.rectPx(v, g.bbox.x0 + dx, g.bbox.y0 + dy, g.bbox.x1 + dx, g.bbox.y1 + dy);
        if (e?.text !== undefined && !e.fit && Math.abs(g.angle) < 0.01) {
          // the outline follows the edited text (measured in the editor's font)
          const f = g.runs[0].font;
          measureCanvas.font = `${cssWeight(f.baseFont, f.bold)} ${g.visualSize * (e.scale ?? 1) * this.zoom}px ${this.editorFamily(f)}`;
          const ratio = measureCanvas.measureText(e.text).width / Math.max(1, measureCanvas.measureText(g.text).width);
          r.width = Math.max(4, r.width * ratio);
        }
        const sel = this.selection?.kind === 'text' && this.selection.key === key && this.selection.id === g.id;
        const box = h('div', {
          class: `hit text${e ? ' edited' : ''}${sel ? ' selected' : ''}`,
          'data-sel': `text|${key}|${g.id}`,
          style: `left:${r.left - 1}px;top:${r.top - 1}px;width:${r.width + 2}px;height:${r.height + 2}px;${e?.deleted ? 'opacity:.5;background:repeating-linear-gradient(45deg,#ff5c6c22 0 4px,transparent 4px 8px)' : ''}${this.tool !== 'edittext' ? ';pointer-events:none' : ''}`,
          title: g.text,
        });
        if (this.tool === 'edittext') this.bindDrag(box, v, {
          onClick: () => this.openTextEditor(v, g),
          onDragEnd: (ddx, ddy) => this.commit((s) => {
            const ed = ((s.textEdits[key] ??= {})[g.id] ??= {});
            ed.dx = (ed.dx ?? 0) + ddx;
            ed.dy = (ed.dy ?? 0) + ddy;
            this.selection = { kind: 'text', key, id: g.id };
          }),
          onDown: () => this.select({ kind: 'text', key, id: g.id }, false),
        });
        L.appendChild(box);
      }
    }
    // objects
    if (this.tool === 'objects') {
      const edits = this.state.xobjEdits[key] ?? {};
      const removedX = new Set(this.state.removals[key] ?? []);
      for (const xo of this.xobjectsOf(key)) {
        if (removedX.has('xo:' + xo.id) || (xo.wm && removedX.has(xo.wm))) continue;
        const e = edits[xo.id];
        const dx = e?.dx ?? 0, dy = e?.dy ?? 0;
        const r = this.rectPx(v, xo.bbox.x0 + dx, xo.bbox.y0 + dy, xo.bbox.x1 + dx, xo.bbox.y1 + dy);
        if (r.width < 2 || r.height < 2) continue;
        const sel = this.selection?.kind === 'obj' && this.selection.key === key && this.selection.id === xo.id;
        const box = h('div', {
          class: `hit obj${sel ? ' selected' : ''}`,
          'data-sel': `obj|${key}|${xo.id}`,
          style: `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;${e?.deleted ? 'opacity:.6;background:repeating-linear-gradient(45deg,#ff5c6c33 0 4px,transparent 4px 8px)' : ''}`,
          title: `${xo.subtype === 'Form' ? 'Vector object' : 'Image'} ${xo.name}`,
        });
        this.bindDrag(box, v, {
          onDown: () => this.select({ kind: 'obj', key, id: xo.id }, false),
          onClick: () => {},
          onDragEnd: (ddx, ddy) => this.commit((s) => {
            const ed = ((s.xobjEdits[key] ??= {})[xo.id] ??= {});
            ed.dx = (ed.dx ?? 0) + ddx;
            ed.dy = (ed.dy ?? 0) + ddy;
          }),
        });
        L.appendChild(box);
      }
    }
    // overlays
    const ovs = this.state.overlays[key] ?? [];
    for (const o of ovs) {
      const r = this.rectPx(v, o.x, o.y, o.x + o.w, o.y + o.h);
      const sel = this.selection?.kind === 'ov' && this.selection.key === key && this.selection.id === o.id;
      const active = this.tool === 'select';
      const box = h('div', {
        class: `hit ov${sel ? ' selected' : ''}`,
        'data-sel': `ov|${key}|${o.id}`,
        style: `left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;height:${r.height + 4}px;${active ? '' : 'pointer-events:none;'}${o.type === 'redact' ? 'outline:1px dashed #ff5c6c;' : ''}`,
      });
      if (active) {
        this.bindDrag(box, v, {
          onDown: () => this.select({ kind: 'ov', key, id: o.id }, false),
          onClick: () => this.drawLayer(v),
          onDblClick: () => o.type === 'text' && this.openOverlayEditor(v, o),
          onDragEnd: (ddx, ddy) => this.commit((s) => {
            const t = s.overlays[key]?.find((x) => x.id === o.id);
            if (t) moveOverlay(t, ddx, ddy);
          }),
        });
        if (sel) {
          const hd = h('div', { class: 'handle' });
          hd.addEventListener('pointerdown', (e) => this.startResize(e, v, o, box));
          box.appendChild(hd);
        }
      }
      L.appendChild(box);
    }
  }

  /** Pointer handling: click vs drag for hit boxes. Calls onDragEnd with a user-space delta. */
  bindDrag(el: HTMLElement, v: PageView, cb: { onClick: () => void; onDragEnd: (dx: number, dy: number) => void; onDown?: () => void; onDblClick?: () => void }) {
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); cb.onDblClick?.(); });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      let dragging = false;
      el.setPointerCapture(e.pointerId);
      cb.onDown?.();
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!dragging && Math.hypot(dx, dy) > 4) dragging = true;
        if (dragging) el.style.transform = `translate(${dx}px,${dy}px)`;
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (dragging) {
          const a = this.toPdf(v, 0, 0), b = this.toPdf(v, ev.clientX - sx, ev.clientY - sy);
          cb.onDragEnd(b[0] - a[0], b[1] - a[1]);
        } else cb.onClick();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  startResize(e: PointerEvent, v: PageView, o: Overlay, box: HTMLElement) {
    e.stopPropagation();
    e.preventDefault();
    const start = box.getBoundingClientRect();
    const lr = v.layer.getBoundingClientRect();
    const left = start.left - lr.left + 2, top = start.top - lr.top + 2;
    const tgt = e.target as HTMLElement;
    tgt.setPointerCapture(e.pointerId);
    let w = start.width - 4, hh = start.height - 4;
    const ratio = w / Math.max(1, hh);
    const keepRatio = o.type === 'image' || o.type === 'text';
    const move = (ev: PointerEvent) => {
      w = Math.max(6, ev.clientX - lr.left - left);
      hh = Math.max(6, ev.clientY - lr.top - top);
      if (keepRatio) hh = w / ratio;
      box.style.width = w + 4 + 'px';
      box.style.height = hh + 4 + 'px';
    };
    const up = () => {
      tgt.removeEventListener('pointermove', move);
      tgt.removeEventListener('pointerup', up);
      const nr = this.pxRectToPdf(v, left, top, w, hh);
      this.commit((s) => {
        const t = s.overlays[v.slot.key]?.find((x) => x.id === o.id);
        if (t) resizeOverlay(t, nr);
      });
    };
    tgt.addEventListener('pointermove', move);
    tgt.addEventListener('pointerup', up);
  }

  bindLayer(v: PageView) {
    v.layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const tool = this.tool;
      if (tool === 'select' || tool === 'edittext' || tool === 'objects') {
        this.select(null);
        return;
      }
      e.preventDefault();
      const [x0, y0] = this.localPoint(v, e);
      if (tool === 'text') return this.addTextAt(v, x0, y0);
      if (tool === 'sign') return this.signatureDialog(v, x0, y0);
      if (tool === 'image') return this.addImageAt(v, x0, y0);
      v.layer.setPointerCapture(e.pointerId);
      const draft = h('div', { class: 'draft' });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'inkdraft');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const col = rgbToHex(tool === 'highlight' ? this.style.highlight : this.style.stroke);
      path.setAttribute('stroke', col);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', String(this.style.lineWidth * this.zoom));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      const pts: number[] = [x0, y0];
      if (tool === 'ink' || tool === 'line' || tool === 'arrow') v.layer.appendChild(svg);
      else v.layer.appendChild(draft);
      let x1 = x0, y1 = y0;
      const move = (ev: PointerEvent) => {
        [x1, y1] = this.localPoint(v, ev);
        if (tool === 'ink') {
          pts.push(x1, y1);
          path.setAttribute('d', 'M' + pts.join(' ').replace(/(\S+ \S+) /g, '$1 L'));
        } else if (tool === 'line' || tool === 'arrow') {
          path.setAttribute('d', `M${x0} ${y0} L${x1} ${y1}`);
        } else {
          Object.assign(draft.style, { left: Math.min(x0, x1) + 'px', top: Math.min(y0, y1) + 'px', width: Math.abs(x1 - x0) + 'px', height: Math.abs(y1 - y0) + 'px' });
        }
      };
      const up = () => {
        v.layer.removeEventListener('pointermove', move);
        v.layer.removeEventListener('pointerup', up);
        draft.remove();
        svg.remove();
        this.finishDraw(v, tool, x0, y0, x1, y1, pts);
      };
      v.layer.addEventListener('pointermove', move);
      v.layer.addEventListener('pointerup', up);
    });
  }

  finishDraw(v: PageView, tool: Tool, x0: number, y0: number, x1: number, y1: number, pts: number[]) {
    const key = v.slot.key;
    const rot = this.totalRotation(v);
    const small = Math.abs(x1 - x0) < 4 && Math.abs(y1 - y0) < 4;
    let ov: Overlay | undefined;
    const r = this.pxRectToPdf(v, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    if (tool === 'ink') {
      if (pts.length < 4) return;
      const up: number[] = [];
      for (let i = 0; i < pts.length; i += 2) up.push(...this.toPdf(v, pts[i], pts[i + 1]));
      ov = { id: uid('o'), type: 'ink', points: [up], stroke: this.style.stroke, lineWidth: this.style.lineWidth, x: 0, y: 0, w: 0, h: 0, rot, opacity: this.style.opacity };
      fitInk(ov);
    } else if (tool === 'line' || tool === 'arrow') {
      if (small) return;
      const a = this.toPdf(v, x0, y0), b = this.toPdf(v, x1, y1);
      ov = { id: uid('o'), type: tool, x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: this.style.stroke, lineWidth: this.style.lineWidth, x: 0, y: 0, w: 0, h: 0, rot, opacity: this.style.opacity };
      fitLine(ov);
    } else {
      let rect = r;
      if (small) {
        // click on a text line: snap to it (highlight / redact / whiteout a line in one click)
        if (tool === 'rect' || tool === 'ellipse') return;
        const [px, py] = this.toPdf(v, x0, y0);
        const g = this.groupsOf(key).find((g) => px >= g.bbox.x0 && px <= g.bbox.x1 && py >= g.bbox.y0 && py <= g.bbox.y1);
        if (!g) return;
        const pad = tool === 'highlight' ? 0.5 : 1;
        rect = { x: g.bbox.x0 - pad, y: g.bbox.y0 - pad, w: g.bbox.x1 - g.bbox.x0 + 2 * pad, h: g.bbox.y1 - g.bbox.y0 + 2 * pad };
      }
      const base = { id: uid('o'), ...rect, rot };
      if (tool === 'highlight') ov = { ...base, type: 'highlight', fill: this.style.highlight, opacity: 0.45 };
      else if (tool === 'whiteout') ov = { ...base, type: 'whiteout' };
      else if (tool === 'redact') ov = { ...base, type: 'redact', fill: [0, 0, 0] };
      else if (tool === 'rect' || tool === 'ellipse') ov = { ...base, type: tool, stroke: this.style.stroke, fill: this.style.fill, lineWidth: this.style.lineWidth, opacity: this.style.opacity };
    }
    if (!ov) return;
    const o = ov;
    this.commit((s) => {
      (s.overlays[key] ??= []).push(o);
    });
    this.selection = { kind: 'ov', key, id: o.id };
    if (tool === 'redact') toast('Redaction: text and images under the box are removed on export');
  }

  // =====================================================================
  // text editing (existing content)
  // =====================================================================
  openTextEditor(v: PageView, g: TextGroup) {
    const key = v.slot.key;
    this.select({ kind: 'text', key, id: g.id }, false);
    const cur = this.state.textEdits[key]?.[g.id] ?? {};
    const edit0 = cur;
    if (cur.deleted) return;
    const dx = cur.dx ?? 0, dy = cur.dy ?? 0;
    const r = this.rectPx(v, g.bbox.x0 + dx, g.bbox.y0 + dy, g.bbox.x1 + dx, g.bbox.y1 + dy);
    const font = g.runs[0].font;
    const size = g.visualSize * (cur.scale ?? 1) * this.zoom;
    const color = cur.color ? rgbToHex(cur.color) : rgbToHex(fillToRgb(g.runs[0].color));
    const ed = h('div', {
      class: 'editor',
      contentEditable: 'plaintext-only',
      spellcheck: false,
      style: `left:${r.left - 2}px;top:${r.top + r.height / 2 - size * 0.62}px;min-width:${r.width + 4}px;font-size:${size}px;font-family:${this.editorFamily(font)};font-weight:${cssWeight(font.baseFont, font.bold)};font-style:${font.italic ? 'italic' : 'normal'};color:${color}`,
    });
    if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
    ed.style.background = this.pageColorAround(v, r);
    ed.textContent = cur.text ?? g.text;
    const status = h('div', { class: 'editor-status' });
    const updateStatus = () => {
      const plan = planTextEdit(g, { ...cur, text: ed.textContent ?? '' }, this.fontPool(key), fallbackPrefs(this.state, this.assets));
      const bottom = r.top + r.height / 2 + size * 0.75;
      status.style.left = r.left + 'px';
      status.style.top = bottom + 4 + 'px';
      for (const f in plan.missingByFont) this.ensureFontMatch(f, plan.missingByFont[f]).then((r) => r !== 'none' && ed.isConnected && updateStatus());
      if (plan.mode === 'substitute' && plan.missing.length && (plan.substituteFont ?? '').split(', ').every((n) => n.startsWith('asset:'))) {
        status.className = 'editor-status ok';
        status.textContent = `✓ ${quoteChars(plan.missing)} drawn with ${this.fontLabel(plan.substituteFont!.split(', ')[0])} – matches the document · Enter to apply`;
      } else if (plan.mode === 'substitute' && Object.keys(plan.missingByFont).some((f) => this.fontPending.has(f))) {
        status.className = 'editor-status';
        status.textContent = `⏳ Fetching the matching font for ${quoteChars(plan.missing)}… (you can keep typing)`;
      } else if (plan.mode === 'substitute' && !edit0.fallbackFont && Object.keys(plan.missingByFont).every((f) => !this.state.fontMatches[f])) {
        status.className = 'editor-status warn';
        status.textContent = `⚠ ${quoteChars(plan.missing)} isn't in this PDF and the matching font couldn't be downloaded (offline?) → using ${this.fontLabel(plan.substituteFont ?? '')} for ${plan.missing.length > 1 ? 'them' : 'it'} only. Use “Use installed font” / “Upload font file” in the Edit panel for an exact match.`;
      } else if (plan.mode === 'substitute') {
        status.className = 'editor-status warn';
        status.textContent = `⚠ ${quoteChars(plan.missing)} ${plan.missing.length > 1 ? 'are' : 'is'} not in this PDF's fonts → drawn with ${this.fontLabel(plan.substituteFont ?? '')}; everything else untouched. Pick the exact font in the Edit panel.`;
      } else {
        status.className = 'editor-status ok';
        status.textContent = `✓ Original fonts kept (${font.displayName}${plan.borrowed.length ? ' + glyphs from its other subsets' : ''}) · only changed characters are rewritten · Enter to apply · Esc to cancel`;
      }
    };
    updateStatus();
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      this.editing = false;
      const text = (ed.textContent ?? '').replace(/\n/g, ' ');
      ed.remove();
      status.remove();
      if (apply && text !== (cur.text ?? g.text)) {
        this.commit((s) => {
          const e = ((s.textEdits[key] ??= {})[g.id] ??= {});
          if (text === g.text) delete e.text;
          else e.text = text;
          if (!Object.keys(e).length) delete s.textEdits[key][g.id];
        });
      } else this.drawLayer(v);
    };
    ed.addEventListener('input', updateStatus);
    ed.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    ed.addEventListener('blur', () => finish(true));
    ed.addEventListener('pointerdown', (e) => e.stopPropagation());
    v.layer.append(ed, status);
    this.editing = true;
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** most common page colour along the border of a box (what's behind the text) */
  pageColorAround(v: PageView, r: { left: number; top: number; width: number; height: number }): string {
    const c = v.canvas;
    if (!c) return '#fff';
    try {
      const k = c.width / v.el.clientWidth;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const counts = new Map<string, number>();
      const pts: [number, number][] = [];
      for (let i = 0; i <= 16; i++) {
        const x = r.left + (r.width * i) / 16;
        pts.push([x, r.top - 2], [x, r.top + r.height + 2]);
      }
      for (let i = 0; i <= 6; i++) {
        const y = r.top + (r.height * i) / 6;
        pts.push([r.left - 3, y], [r.left + r.width + 3, y]);
      }
      for (const [x, y] of pts) {
        const d = ctx.getImageData(Math.max(0, Math.round(x * k)), Math.max(0, Math.round(y * k)), 1, 1).data;
        const key = `${d[0] >> 3},${d[1] >> 3},${d[2] >> 3}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map((n) => (+n << 3) + 4);
      return `rgb(${best.join(',')})`;
    } catch {
      return '#fff';
    }
  }

  /** the editor shows the real typeface: matched/uploaded font, else the fetched open font, else installed */
  editorFamily(font: { baseFont: string; displayName: string; serif: boolean }) {
    const generic = cssFontFamily(font.baseFont, font.serif).split(', ').pop()!;
    const matched = this.state.fontMatches[font.displayName]?.split('|')[0];
    const base = this.autoFonts ? editorFontFamily(font.baseFont, generic) : cssFontFamily(font.baseFont, font.serif);
    return matched?.startsWith('asset:') ? `"${matched}", ${base}` : base;
  }

  updateTextEdit(key: string, gid: string, fn: (e: TextEdit) => void) {
    this.commit((s) => {
      const e = ((s.textEdits[key] ??= {})[gid] ??= {});
      fn(e);
      for (const k of Object.keys(e) as (keyof TextEdit)[]) if (e[k] === undefined) delete e[k];
      if (!Object.keys(e).length) delete s.textEdits[key][gid];
    });
  }

  // =====================================================================
  // overlays: text, image, signature
  // =====================================================================
  addTextAt(v: PageView, px: number, py: number) {
    const rot = this.totalRotation(v);
    const size = this.style.fontSize;
    const r = this.pxRectToPdf(v, px, py - size * this.zoom * 0.6, 10, 10);
    const o: TextOverlay = { id: uid('o'), type: 'text', text: '', x: r.x, y: r.y, w: 10, h: 10, rot, size, color: this.style.textColor, font: this.style.font };
    // anchor: view-top-left at the click
    const tl = this.toPdf(v, px, py - size * this.zoom * 0.6);
    setTextBox(o, tl, measureOverlay(o, this.assets));
    const key = v.slot.key;
    (this.state.overlays[key] ??= []).push(o);
    this.selection = { kind: 'ov', key, id: o.id };
    this.drawLayer(v);
    this.openOverlayEditor(v, o, true);
  }

  openOverlayEditor(v: PageView, o: TextOverlay, isNew = false) {
    const key = v.slot.key;
    const r = this.rectPx(v, o.x, o.y, o.x + o.w, o.y + o.h);
    const fam = o.font.startsWith('asset:') ? `"${o.font}"` : cssFontFamily(o.font, /Times/.test(o.font));
    const ta = h('textarea', {
      class: 'ovedit',
      spellcheck: false,
      style: `left:${r.left}px;top:${r.top}px;width:${Math.max(r.width, 120) + 30}px;height:${r.height + 8}px;font-size:${o.size * this.zoom}px;font-family:${fam};font-weight:${/Bold/.test(o.font) ? 700 : 400};font-style:${/Italic|Oblique/.test(o.font) ? 'italic' : 'normal'};color:${rgbToHex(o.color)}`,
    });
    ta.value = o.text;
    ta.placeholder = 'Type…';
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      ta.style.width = 'auto';
      ta.style.width = Math.max(120, ta.scrollWidth + 30) + 'px';
    };
    let done = false;
    const before = isNew ? undefined : this.snapshot();
    const finish = () => {
      if (done) return;
      done = true;
      this.editing = false;
      const text = ta.value.replace(/\s+$/, '');
      ta.remove();
      const list = this.state.overlays[key] ?? [];
      const t = list.find((x) => x.id === o.id) as TextOverlay | undefined;
      if (!t) return;
      if (!text) {
        this.state.overlays[key] = list.filter((x) => x.id !== o.id);
        this.selection = null;
        if (before) this.pushUndo(before);
        this.scheduleBuild();
        this.renderTabs();
        return;
      }
      if (isNew) {
        // record the creation as one undo step
        const snapWithout = JSON.parse(this.snapshot()) as EditorState;
        snapWithout.overlays[key] = snapWithout.overlays[key].filter((x) => x.id !== o.id);
        this.pushUndo(JSON.stringify(snapWithout));
        t.text = text;
        const tl = topLeftOf(t);
        setTextBox(t, tl, measureOverlay(t, this.assets));
        this.scheduleBuild();
        this.renderTabs();
        this.setTool('select');
      } else if (text !== t.text) {
        this.commit(() => {
          t.text = text;
          setTextBox(t, topLeftOf(t), measureOverlay(t, this.assets));
        });
      } else this.drawLayer(v);
    };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ta.blur(); }
    });
    ta.addEventListener('blur', finish);
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    v.layer.appendChild(ta);
    this.editing = true;
    grow();
    setTimeout(() => ta.focus(), 0);
  }

  async addImageAt(v: PageView, px: number, py: number, assetIn?: Asset) {
    let asset = assetIn;
    if (!asset) {
      const [f] = await pickFiles('image/png,image/jpeg');
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const kind = /png/i.test(f.type) || /\.png$/i.test(f.name) ? 'png' : 'jpg';
      asset = { id: uid('a'), kind, name: f.name, bytes };
      this.assets.set(asset.id, asset);
    }
    const { w, h: hh } = await imageSize(asset.bytes, asset.kind as 'png' | 'jpg');
    const pageW = v.vp!.width / this.zoom;
    const scale = Math.min(1, (pageW * 0.4) / (w * 0.75));
    const dw = w * 0.75 * scale * this.zoom, dh = hh * 0.75 * scale * this.zoom;
    const rot = this.totalRotation(v);
    const r = this.pxRectToPdf(v, px - dw / 2, py - dh / 2, dw, dh);
    const o: Overlay = { id: uid('o'), type: 'image', asset: asset.id, ...r, rot };
    const key = v.slot.key;
    this.commit((s) => { (s.overlays[key] ??= []).push(o); });
    this.selection = { kind: 'ov', key, id: o.id };
    this.setTool('select');
  }

  signatureDialog(v: PageView, px: number, py: number) {
    const c = h('canvas', { class: 'sigpad' });
    let strokes: number[][] = [];
    let color = '#0b1f66';
    const redraw = () => {
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of strokes) {
        ctx.beginPath();
        for (let i = 0; i < s.length; i += 2) (i ? ctx.lineTo(s[i], s[i + 1]) : ctx.moveTo(s[i], s[i + 1]));
        ctx.stroke();
      }
    };
    const typed = h('input', { type: 'text', placeholder: '…or type your name', style: 'flex:1' });
    const bg = h('div', { class: 'modal-bg' });
    const close = () => bg.remove();
    const modal = h('div', { class: 'modal' },
      h('h3', {}, 'Create signature'),
      c,
      h('div', { class: 'row', style: 'margin-top:10px' }, typed,
        h('input', { type: 'color', value: color, oninput: (e: Event) => { color = (e.target as HTMLInputElement).value; redraw(); renderTyped(); } })),
      h('div', { class: 'btns', style: 'justify-content:flex-end;margin-top:6px' },
        h('button', { class: 'btn', onclick: () => { strokes = []; typed.value = ''; redraw(); } }, 'Clear'),
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => place() }, 'Place signature')),
    );
    bg.appendChild(modal);
    bg.addEventListener('pointerdown', (e) => e.target === bg && close());
    document.body.appendChild(bg);
    const dpr = 2;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const renderTyped = () => {
      if (!typed.value) return;
      strokes = [];
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = color;
      ctx.font = `italic ${c.height * 0.38}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(typed.value, c.width / 2, c.height / 2);
    };
    typed.addEventListener('input', renderTyped);
    c.addEventListener('pointerdown', (e) => {
      typed.value = '';
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      const s: number[] = [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
      strokes.push(s);
      const mv = (ev: PointerEvent) => { s.push((ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr); redraw(); };
      const up = () => { c.removeEventListener('pointermove', mv); c.removeEventListener('pointerup', up); };
      c.addEventListener('pointermove', mv);
      c.addEventListener('pointerup', up);
    });
    const place = async () => {
      // crop to content
      const ctx = c.getContext('2d')!;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (data[(y * c.width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 <= x0) return toast('Draw or type a signature first', true);
      const pad = 8;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width, x1 + pad); y1 = Math.min(c.height, y1 + pad);
      const out = h('canvas');
      out.width = x1 - x0;
      out.height = y1 - y0;
      out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      const blob: Blob = await new Promise((res) => out.toBlob((b) => res(b!), 'image/png'));
      const asset: Asset = { id: uid('a'), kind: 'png', name: 'signature.png', bytes: new Uint8Array(await blob.arrayBuffer()) };
      this.assets.set(asset.id, asset);
      close();
      const rot = this.totalRotation(v);
      const dw = Math.min(200, out.width / 4) * this.zoom, dh = (dw * out.height) / out.width;
      const r = this.pxRectToPdf(v, px - dw / 2, py - dh / 2, dw, dh);
      const o: Overlay = { id: uid('o'), type: 'image', asset: asset.id, ...r, rot };
      this.commit((s) => { (s.overlays[v.slot.key] ??= []).push(o); });
      this.selection = { kind: 'ov', key: v.slot.key, id: o.id };
      this.setTool('select');
    };
  }

  // =====================================================================
  // selection / tools
  // =====================================================================
  setTool(t: Tool) {
    this.tool = t;
    this.toolsEl.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tool === t));
    this.viewer.className = `viewer mode-${t}`;
    const cursor = ['select', 'edittext', 'objects'].includes(t) ? 'default' : t === 'text' ? 'text' : 'crosshair';
    this.pagesEl.style.cursor = cursor;
    if (this.selection && ((this.selection.kind === 'text' && t !== 'edittext') || (this.selection.kind === 'obj' && t !== 'objects'))) this.selection = null;
    for (const v of this.views) this.drawLayer(v);
    if (this.tab === 'props') this.renderTabs();
  }

  select(s: Selection, redraw = true) {
    const same = JSON.stringify(s) === JSON.stringify(this.selection);
    this.selection = s;
    if (redraw) for (const v of this.views) this.drawLayer(v);
    else this.markSelection();
    if (!same || redraw) {
      this.tab = 'props';
      this.renderTabs();
    }
  }

  /** Toggle selection classes without rebuilding hit boxes (keeps pointer capture alive). */
  markSelection() {
    const want = this.selection ? `${this.selection.kind}|${this.selection.key}|${this.selection.id}` : '';
    this.pagesEl.querySelectorAll<HTMLElement>('.hit').forEach((el) => el.classList.toggle('selected', el.dataset.sel === want));
  }

  deleteSelection() {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'ov') this.commit((st) => { st.overlays[s.key] = (st.overlays[s.key] ?? []).filter((o) => o.id !== s.id); });
    else if (s.kind === 'text') this.updateTextEdit(s.key, s.id, (e) => { e.deleted = true; });
    else if (s.kind === 'obj') this.commit((st) => { ((st.xobjEdits[s.key] ??= {})[s.id] ??= {}).deleted = true; });
    if (s.kind === 'ov') this.selection = null;
  }

  // =====================================================================
  // inspector
  // =====================================================================
  renderTabs() {
    const tabs = this.inspector.querySelector('.tabs')!;
    tabs.innerHTML = '';
    const mk = (id: typeof this.tab, label: string) =>
      h('button', { class: this.tab === id ? 'active' : '', onclick: () => { this.tab = id; this.renderTabs(); } }, label);
    const nwm = this.report?.watermarks.length ?? 0;
    tabs.append(mk('props', 'Edit'), mk('find', 'Find'), mk('wm', `Watermarks${nwm ? ` (${nwm})` : ''}`), mk('forms', `Forms${this.fields.length ? ` (${this.fields.length})` : ''}`), mk('doc', 'Doc'));
    const scroll = this.tabbody.scrollTop;
    this.tabbody.innerHTML = '';
    if (!this.primaryId) {
      this.tabbody.append(h('div', { class: 'hint' }, 'Open a document to get started.'));
      return;
    }
    if (this.tab === 'props') this.renderProps();
    else if (this.tab === 'find') this.renderFind();
    else if (this.tab === 'forms') this.renderForms();
    else if (this.tab === 'wm') this.renderWatermarks();
    else this.renderDoc();
    this.tabbody.scrollTop = scroll;
  }

  renderProps() {
    const b = this.tabbody;
    const s = this.selection;
    if (s?.kind === 'text') return this.renderTextProps(s.key, s.id);
    if (s?.kind === 'obj') return this.renderObjProps(s.key, s.id);
    if (s?.kind === 'ov') {
      const o = this.state.overlays[s.key]?.find((x) => x.id === s.id);
      if (o) return this.renderOverlayProps(s.key, o);
    }
    const tip: Partial<Record<Tool, string>> = {
      select: 'Click an annotation you added to select it. Drag to move it, use the corner handle to resize, double-click text to edit, Delete to remove.',
      edittext: 'Click any text in the document to edit it in place. The engine re-encodes your text with the PDF\'s own embedded font. Drag a line to move it.',
      objects: 'Images and embedded graphics are outlined. Drag to move them, or select one to delete or replace it.',
      text: 'Click anywhere on a page to add text.',
      image: 'Click on a page to place an image.',
      sign: 'Click where the signature should go.',
      ink: 'Draw freehand on the page.',
      highlight: 'Drag over an area, or click a line of text to highlight it.',
      whiteout: 'Drag to cover an area in white (content stays underneath — use Redact to remove it).',
      redact: 'Drag a box or click a line. The text glyphs and images under it are removed from the file on export.',
    };
    b.append(h('div', { class: 'sec' }, h('h4', {}, TOOLS.find((t) => t.id === this.tool)?.tip.replace(/ \(.*\)$/, '') ?? 'Tool'), h('div', { class: 'hint' }, tip[this.tool] ?? 'Drag on a page to draw.')));
    // tool defaults
    const st = this.style;
    const sec = h('div', { class: 'sec' }, h('h4', {}, 'Defaults'));
    if (['rect', 'ellipse', 'line', 'arrow', 'ink'].includes(this.tool)) {
      sec.append(
        colorRow('Stroke', st.stroke, (c) => (st.stroke = c)),
        h('div', { class: 'row' }, h('label', {}, 'Fill'), h('input', { type: 'checkbox', checked: !!st.fill, onchange: (e: Event) => { st.fill = (e.target as HTMLInputElement).checked ? [1, 1, 1] : null; this.renderTabs(); } }), st.fill ? h('input', { type: 'color', value: rgbToHex(st.fill), oninput: (e: Event) => (st.fill = hexToRgb((e.target as HTMLInputElement).value)) }) : null),
        rangeRow('Width', st.lineWidth, 0.5, 20, 0.5, (n) => (st.lineWidth = n)),
        rangeRow('Opacity', st.opacity, 0.1, 1, 0.05, (n) => (st.opacity = n)),
      );
    } else if (this.tool === 'text') {
      sec.append(fontRow(st.font, this.assets, (f) => (st.font = f)), numRow('Size', st.fontSize, (n) => (st.fontSize = n)), colorRow('Color', st.textColor, (c) => (st.textColor = c)));
    } else if (this.tool === 'highlight') {
      sec.append(colorRow('Color', st.highlight, (c) => (st.highlight = c)));
    } else return;
    b.append(sec);
  }

  renderTextProps(key: string, gid: string) {
    const b = this.tabbody;
    const g = this.groupsOf(key).find((x) => x.id === gid);
    if (!g) return;
    const e = this.state.textEdits[key]?.[gid] ?? {};
    const run = g.runs[0];
    const font = run.font;
    const plan = planTextEdit(g, e, this.fontPool(key), fallbackPrefs(this.state, this.assets));
    const status =
      plan.mode === 'delete' ? h('span', { class: 'pill warn' }, 'Deleted')
      : plan.mode === 'substitute' && plan.missing.length && (plan.substituteFont ?? '').startsWith('asset:') && !plan.substituteFont!.includes(',')
        ? h('span', { class: 'pill ok', style: 'white-space:normal' }, `✓ ${quoteChars(plan.missing)} drawn with ${this.fontLabel(plan.substituteFont!)}${this.autoMatched.has(font.displayName) ? ' (matched automatically)' : ''} — the rest is untouched`)
      : plan.mode === 'substitute' ? h('span', { class: 'pill warn', style: 'white-space:normal' }, plan.missing.length ? `Not in this PDF's font: ${quoteChars(plan.missing)} — only ${plan.missing.length > 1 ? 'these use' : 'this uses'} ${this.fontLabel(plan.substituteFont ?? '')}, the rest is untouched` : 'Fallback font forced')
      : e.text !== undefined || plan.mode === 'reemit-original' ? h('span', { class: 'pill ok' }, '✓ Edited in original font')
      : h('span', { class: 'pill info' }, 'Original');
    const view = this.views.find((v) => v.slot.key === key);
    b.append(
      h('div', { class: 'sec' }, h('h4', {}, 'Text'), status,
        h('textarea', { style: 'width:100%;margin-top:8px;min-height:64px', value: e.text ?? g.text, onchange: (ev: Event) => {
          const t = (ev.target as HTMLTextAreaElement).value.replace(/\n/g, ' ');
          this.updateTextEdit(key, gid, (x) => { x.text = t === g.text ? undefined : t; });
        } }),
        h('div', { class: 'btns', style: 'margin-top:6px' },
          view ? h('button', { class: 'btn small', onclick: () => this.openTextEditor(view, g) }, 'Edit inline') : null,
          e.deleted
            ? h('button', { class: 'btn small', onclick: () => this.updateTextEdit(key, gid, (x) => { x.deleted = undefined; }) }, 'Restore')
            : h('button', { class: 'btn small danger', onclick: () => this.updateTextEdit(key, gid, (x) => { x.deleted = true; }) }, icon('trash'), 'Delete'),
          Object.keys(e).length ? h('button', { class: 'btn small', onclick: () => this.commit((s) => { delete s.textEdits[key][gid]; }) }, 'Reset to original') : null,
        )),
      h('div', { class: 'sec' }, h('h4', {}, 'Style'),
        numRow('Size (pt)', +(g.visualSize * (e.scale ?? 1)).toFixed(2), (n) => this.updateTextEdit(key, gid, (x) => { x.scale = n > 0 ? n / g.visualSize : undefined; if (x.scale && Math.abs(x.scale - 1) < 1e-3) x.scale = undefined; })),
        colorRow('Color', e.color ?? fillToRgb(run.color), (c) => this.updateTextEdit(key, gid, (x) => { x.color = c; })),
        h('div', { class: 'row' }, h('label', {}, 'Offset'), h('span', { class: 'muted' }, `${(e.dx ?? 0).toFixed(1)}, ${(e.dy ?? 0).toFixed(1)} pt`),
          e.dx || e.dy ? h('button', { class: 'btn small', onclick: () => this.updateTextEdit(key, gid, (x) => { x.dx = undefined; x.dy = undefined; }) }, 'Reset') : null),
        rangeRow('Opacity', +(e.opacity ?? run.alpha).toFixed(2), 0, 1, 0.01, (n) => this.updateTextEdit(key, gid, (x) => { x.opacity = Math.abs(n - run.alpha) < 1e-3 ? undefined : n; }), true),
        h('div', { class: 'row' }, h('label', {}, 'Rotate°'), h('input', { type: 'number', step: '1', value: String(e.rotate ?? 0), onchange: (ev: Event) => { const v = parseFloat((ev.target as HTMLInputElement).value) || 0; this.updateTextEdit(key, gid, (x) => { x.rotate = v || undefined; }); } })),
        h('div', { class: 'hint', style: 'margin:-2px 0 8px' }, 'Untouched properties are inherited from the original – colour space, shade, transparency and layering stay exactly as they were.'),
        h('div', { class: 'row' }, h('label', {}, 'Fit width'), h('input', { type: 'checkbox', checked: !!e.fit, onchange: (ev: Event) => this.updateTextEdit(key, gid, (x) => { x.fit = (ev.target as HTMLInputElement).checked || undefined; }) }), h('span', { class: 'hint' }, 'shrink longer text to the original width')),
        h('div', { class: 'row' }, h('label', {}, 'Reflow'), h('input', { type: 'checkbox', checked: !e.noReflow, onchange: (ev: Event) => this.updateTextEdit(key, gid, (x) => { x.noReflow = (ev.target as HTMLInputElement).checked ? undefined : true; }) }), h('span', { class: 'hint' }, 'slide the rest of the line')),
      ),
      h('div', { class: 'sec' }, h('h4', {}, 'Font'),
        h('div', { class: 'kv' },
          h('div', {}, 'Name'), h('div', {}, font.displayName),
          h('div', {}, 'Type'), h('div', {}, font.subtype + (font.isType0 ? ' (CID)' : '')),
          h('div', {}, 'Embedded'), h('div', {}, font.embedded ? (font.isSubset ? 'Yes – subset' : 'Yes – full') : 'No (viewer font)'),
          h('div', {}, 'Unicode map'), h('div', {}, font.hasToUnicode ? 'ToUnicode CMap' : 'Encoding'),
        ),
        h('div', { class: 'hint', style: 'margin-top:8px' }, font.isSubset || font.isType3
          ? `This PDF only carries the characters it already used from ${font.displayName}${font.isType3 ? ' (Type 3 glyph subset, typical of Chrome / Google Docs exports)' : ''}. Characters you type are taken from it and from its other subsets in the file; anything it never contained must come from a second font – choose the real ${font.displayName} below and they will match exactly.`
          : 'Characters you type are encoded in this embedded font.'),
        h('div', { class: 'sec', style: 'margin:10px 0 0;padding:10px;border:1px solid var(--line);border-radius:8px' },
          h('div', { style: 'font-weight:600;margin-bottom:6px' }, `Missing characters of ${font.displayName}`),
          h('div', { class: 'hint', style: 'margin-bottom:8px' }, this.fontPending.has(font.displayName) ? '⏳ Fetching the matching font…' : `Used for every line in this font: ${this.fontLabel(this.state.fontMatches[font.displayName] ?? 'automatic')}${this.autoMatched.has(font.displayName) ? ' (matched automatically)' : ''}`),
          h('div', { class: 'btns' },
            h('button', { class: 'btn small primary', onclick: () => this.ensureFontMatch(font.displayName, plan.missing.length ? plan.missing : [','], true) }, this.fontPending.has(font.displayName) ? 'Matching…' : `Match ${prettyName(font.displayName)} now`),
            'queryLocalFonts' in window ? h('button', { class: 'btn small', onclick: () => this.matchLocalFont(font.displayName, (id) => this.setFontMatch(font.displayName, 'asset:' + id)) }, 'Use installed font') : null,
            h('button', { class: 'btn small', onclick: () => this.uploadFont((id) => this.setFontMatch(font.displayName, 'asset:' + id)) }, 'Upload font file…'),
          ),
          fontRow(this.state.fontMatches[font.displayName] ?? '', this.assets, (f) => this.setFontMatch(font.displayName, f || undefined), 'Or use', true),
        ),
        h('label', { class: 'hint', style: 'display:flex;align-items:center;gap:6px;margin-top:8px' }, h('input', { type: 'checkbox', checked: !!e.forceFallback, onchange: (ev: Event) => this.updateTextEdit(key, gid, (x) => { x.forceFallback = (ev.target as HTMLInputElement).checked || undefined; }) }), 'Draw this whole line with the chosen font'),
      ),
    );
  }

  setFontMatch(fontName: string, value: string | undefined) {
    this.autoMatched.delete(fontName);
    this.commit((s) => {
      if (value) s.fontMatches[fontName] = value;
      else delete s.fontMatches[fontName];
    });
    toast(value ? `Missing characters of ${fontName} now use ${this.fontLabel(value)}` : `Automatic fallback for ${fontName}`);
  }

  fontLabel(name: string) {
    name = name.split('|')[0];
    if (name.startsWith('asset:')) return (this.assets.get(name.slice(6))?.name ?? 'uploaded font').replace(/ \((latin-ext|cyrillic|greek|vietnamese)\)$/, '');
    return prettyFont(name);
  }

  /**
   * Automatic font matching: when a character is missing from an embedded font, fetch the real
   * typeface (or its metric twin) once, cache it, and use it for every line in that font.
   * Resolves true only when a new font was added.
   */
  ensureFontMatch(fontName: string, need: string[], force = false): Promise<'new' | 'failed' | 'none'> {
    const chars = [...new Set(need)].filter((c) => !/\s/.test(c));
    if ((!this.autoFonts && !force) || !chars.length) return Promise.resolve('none');
    const cur = this.state.fontMatches[fontName];
    if (cur && !this.autoMatched.has(fontName)) return Promise.resolve('none'); // the user chose a font – respect it
    const prefs = fallbackPrefs(this.state, this.assets);
    const todo = chars.filter((c) => !cur?.split('|').some((m) => prefs.covers!(m, c)));
    if (!todo.length) return Promise.resolve('none'); // already matched – nothing new
    const jobKey = fontName + '|' + todo.sort().join('');
    if (this.fontFailed.has(jobKey) && !force) return Promise.resolve('none');
    let job = this.fontJobs.get(jobKey);
    if (job) return job;
    job = (async () => {
      this.fontPending.add(fontName);
      this.setStatus(`Matching ${prettyName(fontName)}…`, true);
      const { parts } = await downloadMatch(fontName, todo);
      this.fontPending.delete(fontName);
      this.setStatus('Ready');
      if (!parts.length) {
        this.fontFailed.add(jobKey);
        if (force) toast(`No open version of ${prettyName(fontName)} is available (or you are offline). Use “Use installed font” or “Upload font file”.`, true, 6000);
        this.renderTabs();
        return 'failed' as const;
      }
      const ids = parts.map((p) => this.addFontAsset(p.bytes, p.label, true)).filter((x): x is string => !!x);
      const list = [...new Set([...(this.state.fontMatches[fontName]?.split('|') ?? []), ...ids.map((i) => 'asset:' + i)])];
      this.state.fontMatches[fontName] = list.join('|');
      this.autoMatched.add(fontName);
      this.scheduleBuild();
      this.renderTabs();
      return 'new' as const;
    })();
    this.fontJobs.set(jobKey, job);
    job.finally(() => this.fontJobs.delete(jobKey));
    return job;
  }

  /** after every build: auto-match fonts for any edited line that still needs a fallback */
  autoMatchEdits() {
    if (!this.autoFonts) return;
    for (const key in this.state.textEdits) {
      const groups = this.groupsOf(key);
      for (const gid in this.state.textEdits[key]) {
        const g = groups.find((x) => x.id === gid);
        if (!g) continue;
        const plan = planTextEdit(g, this.state.textEdits[key][gid], this.fontPool(key), fallbackPrefs(this.state, this.assets));
        for (const f in plan.missingByFont) this.ensureFontMatch(f, plan.missingByFont[f]);
      }
    }
  }

  renderObjProps(key: string, id: string) {
    const xo = this.xobjectsOf(key).find((x) => x.id === id);
    if (!xo) return;
    const e = this.state.xobjEdits[key]?.[id] ?? {};
    const upd = (fn: (x: { deleted?: boolean; dx?: number; dy?: number; replaceAsset?: string }) => void) =>
      this.commit((s) => {
        const x = ((s.xobjEdits[key] ??= {})[id] ??= {});
        fn(x);
        if (!Object.values(x).some((v) => v !== undefined)) delete s.xobjEdits[key][id];
      });
    this.tabbody.append(h('div', { class: 'sec' }, h('h4', {}, xo.subtype === 'Form' ? 'Vector object' : 'Image'),
      h('div', { class: 'kv' },
        h('div', {}, 'Resource'), h('div', {}, xo.name || '(inline)'),
        h('div', {}, 'Size'), h('div', {}, `${(xo.bbox.x1 - xo.bbox.x0).toFixed(1)} × ${(xo.bbox.y1 - xo.bbox.y0).toFixed(1)} pt`),
        h('div', {}, 'Offset'), h('div', {}, `${(e.dx ?? 0).toFixed(1)}, ${(e.dy ?? 0).toFixed(1)} pt`),
      ),
      h('div', { class: 'btns', style: 'margin-top:10px' },
        e.deleted ? h('button', { class: 'btn small', onclick: () => upd((x) => { x.deleted = undefined; }) }, 'Restore')
          : h('button', { class: 'btn small danger', onclick: () => upd((x) => { x.deleted = true; }) }, icon('trash'), 'Delete'),
        h('button', { class: 'btn small', onclick: async () => {
          const [f] = await pickFiles('image/png,image/jpeg');
          if (!f) return;
          const a: Asset = { id: uid('a'), kind: /png/i.test(f.type) ? 'png' : 'jpg', name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
          this.assets.set(a.id, a);
          upd((x) => { x.replaceAsset = a.id; });
        } }, 'Replace image…'),
        Object.keys(e).length ? h('button', { class: 'btn small', onclick: () => this.commit((s) => { delete s.xobjEdits[key][id]; }) }, 'Reset') : null,
      )));
  }

  renderOverlayProps(key: string, o: Overlay) {
    const upd = (fn: (x: Overlay) => void) => this.commit((s) => { const t = s.overlays[key]?.find((x) => x.id === o.id); if (t) fn(t); });
    const sec = h('div', { class: 'sec' }, h('h4', {}, ({ text: 'Text box', image: 'Image', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', ink: 'Drawing', highlight: 'Highlight', whiteout: 'Whiteout', redact: 'Redaction' } as Record<string, string>)[o.type]));
    if (o.type === 'text') {
      sec.append(
        h('textarea', { style: 'width:100%;min-height:70px;margin-bottom:8px', value: o.text, onchange: (e: Event) => upd((t) => { const tt = t as TextOverlay; tt.text = (e.target as HTMLTextAreaElement).value; setTextBox(tt, topLeftOf(tt), measureOverlay(tt, this.assets)); }) }),
        fontRow(o.font, this.assets, (f) => upd((t) => { const tt = t as TextOverlay; tt.font = f; setTextBox(tt, topLeftOf(tt), measureOverlay(tt, this.assets)); })),
        h('div', { class: 'btns', style: 'margin-bottom:8px' }, h('button', { class: 'btn small', onclick: () => this.uploadFont((id) => upd((t) => { const tt = t as TextOverlay; tt.font = 'asset:' + id; setTextBox(tt, topLeftOf(tt), measureOverlay(tt, this.assets)); })) }, 'Upload font…')),
        !o.font.startsWith('asset:') && unsupportedStandardChars(o.text).length
          ? h('div', { class: 'pill warn', style: 'margin-bottom:8px;white-space:normal' }, `${unsupportedStandardChars(o.text).join(' ')} can't be shown by standard fonts – upload a font that has them`)
          : '',
        numRow('Size', o.size, (n) => upd((t) => { const tt = t as TextOverlay; tt.size = n; setTextBox(tt, topLeftOf(tt), measureOverlay(tt, this.assets)); })),
        colorRow('Color', o.color, (c) => upd((t) => { (t as TextOverlay).color = c; })),
        h('div', { class: 'row' }, h('label', {}, 'Align'), h('select', { onchange: (e: Event) => upd((t) => { (t as TextOverlay).align = (e.target as HTMLSelectElement).value as 'left'; }) },
          ...['left', 'center', 'right'].map((a) => h('option', { value: a, selected: (o.align ?? 'left') === a }, a)))),
      );
    }
    if (o.type === 'rect' || o.type === 'ellipse') {
      sec.append(
        h('div', { class: 'row' }, h('label', {}, 'Stroke'), h('input', { type: 'checkbox', checked: !!o.stroke, onchange: (e: Event) => upd((t) => { (t as typeof o).stroke = (e.target as HTMLInputElement).checked ? [0, 0, 0] : null; }) }), o.stroke ? h('input', { type: 'color', value: rgbToHex(o.stroke), onchange: (e: Event) => upd((t) => { (t as typeof o).stroke = hexToRgb((e.target as HTMLInputElement).value); }) }) : null),
        h('div', { class: 'row' }, h('label', {}, 'Fill'), h('input', { type: 'checkbox', checked: !!o.fill, onchange: (e: Event) => upd((t) => { (t as typeof o).fill = (e.target as HTMLInputElement).checked ? [1, 1, 1] : null; }) }), o.fill ? h('input', { type: 'color', value: rgbToHex(o.fill), onchange: (e: Event) => upd((t) => { (t as typeof o).fill = hexToRgb((e.target as HTMLInputElement).value); }) }) : null),
        rangeRow('Width', o.lineWidth ?? 1, 0.5, 20, 0.5, (n) => upd((t) => { (t as typeof o).lineWidth = n; }), true),
      );
    }
    if (o.type === 'line' || o.type === 'arrow' || o.type === 'ink') {
      sec.append(colorRow('Color', o.stroke, (c) => upd((t) => { (t as typeof o).stroke = c; })), rangeRow('Width', o.lineWidth, 0.5, 20, 0.5, (n) => upd((t) => { (t as typeof o).lineWidth = n; }), true));
    }
    if (o.type === 'highlight') sec.append(colorRow('Color', o.fill ?? [1, 0.85, 0.1], (c) => upd((t) => { (t as typeof o).fill = c; })));
    if (o.type === 'redact') sec.append(h('div', { class: 'hint' }, 'On export, every glyph whose centre lies inside this box is removed from the content stream, plus any image fully inside it. The box is then painted.'), colorRow('Fill', o.fill ?? [0, 0, 0], (c) => upd((t) => { (t as typeof o).fill = c; })));
    if (o.type !== 'redact' && o.type !== 'whiteout') sec.append(rangeRow('Opacity', o.opacity ?? (o.type === 'highlight' ? 0.45 : 1), 0.05, 1, 0.05, (n) => upd((t) => { t.opacity = n; }), true));
    sec.append(h('div', { class: 'btns', style: 'margin-top:8px' },
      h('button', { class: 'btn small', onclick: () => this.commit((s) => { const l = s.overlays[key]; const c = structuredClone(l.find((x) => x.id === o.id)!); c.id = uid('o'); moveOverlay(c, 10, -10); l.push(c); }) }, 'Duplicate'),
      h('button', { class: 'btn small', onclick: () => this.commit((s) => { const l = s.overlays[key]; const i = l.findIndex((x) => x.id === o.id); l.push(...l.splice(i, 1)); }) }, 'Bring to front'),
      h('button', { class: 'btn small danger', onclick: () => this.deleteSelection() }, icon('trash'), 'Delete')));
    this.tabbody.append(sec);
  }

  async uploadFont(done: (assetId: string) => void) {
    const [f] = await pickFiles('.ttf,.otf,font/ttf,font/otf');
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const id = this.addFontAsset(bytes, f.name.replace(/\.[^.]+$/, ''));
    if (id) done(id);
  }

  addFontAsset(bytes: Uint8Array, name: string, silent = false): string | undefined {
    try {
      const fk = (fontkit as unknown as { create(b: Uint8Array): unknown }).create(bytes) as unknown as { layout?: unknown; fonts?: unknown };
      if (!fk.layout) throw new Error('font collections (.ttc) are not supported');
    } catch (e) {
      toast('Could not read font: ' + (e as Error).message, true, 4000);
      return undefined;
    }
    const a: Asset = { id: uid('f'), kind: 'font', name, bytes };
    this.assets.set(a.id, a);
    try {
      const ff = new FontFace('asset:' + a.id, bytes as BufferSource);
      ff.load().then((x) => document.fonts.add(x)).catch(() => {});
    } catch { /* display only */ }
    if (!silent) toast(`Font “${name}” loaded`);
    return a.id;
  }

  async matchLocalFont(name: string, done: (assetId: string) => void) {
    try {
      const q = (window as unknown as { queryLocalFonts: () => Promise<{ postscriptName: string; fullName: string; family: string; style: string; blob(): Promise<Blob> }[]> }).queryLocalFonts;
      const fonts = await q();
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(mt|ps|regular|roman)$/g, '');
      const target = norm(name.replace(/^[A-Z]{6}\+/, '').replace(/,/g, '-'));
      const f = fonts.find((x) => norm(x.postscriptName) === target) ?? fonts.find((x) => norm(x.fullName) === target) ?? fonts.find((x) => norm(x.family) === target && /regular|normal|book/i.test(x.style));
      if (!f) return toast(`“${name}” is not installed on this device`, true, 4000);
      const bytes = new Uint8Array(await (await f.blob()).arrayBuffer());
      const id = this.addFontAsset(bytes, f.fullName);
      if (id) done(id);
    } catch (e) {
      toast('Local font access was denied or failed: ' + (e as Error).message, true, 4000);
    }
  }

  // ---------------- find & replace ----------------
  findMatches() {
    const q = this.findQuery;
    if (!q) return [];
    const out: { pageIndex: number; key: string; g: TextGroup; text: string; at: number }[] = [];
    const norm = (s: string) => (this.findCase ? s : s.toLowerCase());
    const nq = norm(q);
    this.state.pages.forEach((slot, pageIndex) => {
      const edits = this.state.textEdits[slot.key] ?? {};
      for (const g of this.groupsOf(slot.key)) {
        const e = edits[g.id];
        if (e?.deleted) continue;
        const text = e?.text ?? g.text;
        let at = norm(text).indexOf(nq);
        while (at >= 0) {
          out.push({ pageIndex, key: slot.key, g, text, at });
          at = norm(text).indexOf(nq, at + nq.length);
        }
      }
    });
    return out;
  }

  renderFind() {
    const b = this.tabbody;
    const results = h('div', {});
    const draw = () => {
      results.innerHTML = '';
      const ms = this.findMatches();
      if (this.findQuery) results.append(h('div', { class: 'hint', style: 'margin-bottom:8px' }, `${ms.length} match${ms.length === 1 ? '' : 'es'}`));
      for (const m of ms.slice(0, 300)) {
        const s = Math.max(0, m.at - 28);
        results.append(h('div', { class: 'match', onclick: () => this.revealGroup(m.pageIndex, m.g) },
          h('div', { class: 'pg' }, `Page ${m.pageIndex + 1}`),
          s > 0 ? '…' : '', m.text.slice(s, m.at), h('b', {}, m.text.slice(m.at, m.at + this.findQuery.length)), m.text.slice(m.at + this.findQuery.length, m.at + this.findQuery.length + 40)));
      }
    };
    const fi = h('input', { type: 'text', placeholder: 'Find text…', value: this.findQuery, oninput: (e: Event) => { this.findQuery = (e.target as HTMLInputElement).value; draw(); } });
    const ri = h('input', { type: 'text', placeholder: 'Replace with…', value: this.replaceText, oninput: (e: Event) => { this.replaceText = (e.target as HTMLInputElement).value; } });
    b.append(h('div', { class: 'sec' }, h('h4', {}, 'Find & replace'),
      h('div', { class: 'row' }, fi), h('div', { class: 'row' }, ri),
      h('div', { class: 'row' }, h('label', { style: 'width:auto;display:flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: this.findCase, onchange: (e: Event) => { this.findCase = (e.target as HTMLInputElement).checked; draw(); } }), 'Match case')),
      h('div', { class: 'btns' }, h('button', { class: 'btn primary small', onclick: () => this.replaceAll() }, 'Replace all')),
      h('div', { class: 'hint', style: 'margin-top:8px' }, 'Replacements are written into the original text runs using the document\'s own fonts.')),
      results);
    draw();
  }

  replaceAll() {
    const q = this.findQuery;
    if (!q) return;
    const ms = this.findMatches();
    if (!ms.length) return toast('No matches');
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), this.findCase ? 'g' : 'gi');
    let n = 0;
    let subs = 0;
    this.commit((s) => {
      const seen = new Set<string>();
      for (const m of ms) {
        const k = m.key + '|' + m.g.id;
        if (seen.has(k)) continue;
        seen.add(k);
        const e = ((s.textEdits[m.key] ??= {})[m.g.id] ??= {});
        const next = (e.text ?? m.g.text).replace(re, () => { n++; return this.replaceText; });
        e.text = next;
        if (planTextEdit(m.g, e, this.fontPool(m.key), fallbackPrefs(this.state, this.assets)).mode === 'substitute') subs++;
      }
    });
    toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}${subs ? ` · ${subs} line(s) needed a fallback font` : ''}`, false, 4000);
    this.renderTabs();
  }

  revealGroup(pageIndex: number, g: TextGroup) {
    const v = this.views[pageIndex];
    if (!v) return;
    if (this.tool !== 'edittext') this.setTool('edittext');
    const r = this.rectPx(v, g.bbox.x0, g.bbox.y0, g.bbox.x1, g.bbox.y1);
    this.viewer.scrollTo({ top: v.el.offsetTop + r.top - this.viewer.clientHeight / 3, behavior: 'smooth' });
    this.selection = { kind: 'text', key: v.slot.key, id: g.id };
    this.drawLayer(v);
  }

  // ---------------- watermarks ----------------
  isRemoved(d: DetectedWatermark) {
    return d.hits.every((h) => h.targets.every((t) => this.state.removals[h.key]?.includes(t)));
  }
  setRemoved(d: DetectedWatermark, on: boolean) {
    this.commit((s) => {
      for (const h of d.hits) {
        const cur = new Set(s.removals[h.key] ?? []);
        for (const t of h.targets) (on ? cur.add(t) : cur.delete(t));
        if (cur.size) s.removals[h.key] = [...cur];
        else delete s.removals[h.key];
      }
    });
  }
  editDetected(d: DetectedWatermark, fn: (e: TextEdit) => void) {
    this.commit((s) => {
      for (const h of d.hits) for (const gid of h.groupIds) {
        const e = ((s.textEdits[h.key] ??= {})[gid] ??= {});
        fn(e);
        for (const k of Object.keys(e) as (keyof TextEdit)[]) if (e[k] === undefined) delete e[k];
        if (!Object.keys(e).length) delete s.textEdits[h.key][gid];
      }
    });
  }
  newWatermark(kind: 'text' | 'image', base?: Partial<Watermark>): Watermark {
    return { id: uid('w'), kind, text: 'CONFIDENTIAL', font: 'Helvetica-Bold', size: 64, color: [0.75, 0.12, 0.12], opacity: kind === 'image' ? 0.2 : 0.25, angle: kind === 'image' ? 0 : 45, position: 'center', layer: 'over', pages: '', enabled: true, imageScale: 0.5, gap: 1, ...base };
  }
  updWm(id: string, fn: (w: Watermark) => void) {
    this.commit((s) => { const w = s.watermarks.find((x) => x.id === id); if (w) fn(w); });
  }

  renderWatermarks() {
    const b = this.tabbody;
    const r = this.report;
    // --- smart scan summary
    const scan = h('div', { class: 'sec' }, h('h4', {}, 'Smart scan'));
    if (!r || this.scanning) scan.append(h('div', { class: 'hint' }, 'Scanning every page for watermarks, fonts and structure…'));
    else {
      scan.append(h('div', { class: 'hint' }, `${r.pages} pages · ${r.textLines} text lines · ${r.images} images · ${r.fonts} fonts`));
      if (r.scannedPages.length) scan.append(h('div', { class: 'pill warn', style: 'margin-top:6px;white-space:normal' }, `Page${r.scannedPages.length > 1 ? 's' : ''} ${r.scannedPages.join(', ')} look scanned (image only) – annotate, redact or watermark them; their text is a picture.`));
      if (r.invisibleTextPages.length) scan.append(h('div', { class: 'pill info', style: 'margin-top:6px;white-space:normal' }, `Hidden OCR text layer on page${r.invisibleTextPages.length > 1 ? 's' : ''} ${r.invisibleTextPages.join(', ')} – searchable and editable.`));
      scan.append(h('div', { class: 'btns', style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: () => { this.computeReport(); this.renderTabs(); } }, 'Rescan')));
    }
    b.append(scan);

    // --- detected
    const det = h('div', { class: 'sec' }, h('h4', {}, `Detected in this document (${r?.watermarks.length ?? 0})`));
    if (r && !r.watermarks.length) det.append(h('div', { class: 'hint' }, 'No watermarks found. Add one below.'));
    for (const d of r?.watermarks ?? []) {
      const removed = this.isRemoved(d);
      const firstHit = d.hits[0];
      const editable = !removed && d.hits.every((x) => x.groupIds.length === 1);
      const cur = editable ? this.state.textEdits[firstHit.key]?.[firstHit.groupIds[0]] ?? {} : {};
      const card = h('div', { class: 'match', style: `cursor:default;${removed ? 'opacity:.6' : ''}` },
        h('div', { style: 'display:flex;justify-content:space-between;gap:6px;align-items:center' },
          h('b', { style: 'background:none;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, (cur.text ?? d.label).slice(0, 40)),
          h('span', { class: `pill ${d.confidence === 'certain' ? 'ok' : 'warn'}` }, d.confidence)),
        h('div', { class: 'pg', style: 'margin:3px 0 8px' }, `${({ artifact: 'Tagged watermark', acrobat: 'Acrobat watermark', annotation: 'Annotation', text: 'Text', image: 'Image' } as Record<string, string>)[d.kind]} · ${d.hits.length} page${d.hits.length > 1 ? 's' : ''} · ${d.reason}`),
      );
      if (editable && d.sample) {
        const smp = d.sample;
        card.append(
          h('div', { class: 'row' }, h('label', {}, 'Text'), h('input', { type: 'text', value: cur.text ?? smp.text, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; this.editDetected(d, (x) => { x.text = v === smp.text ? undefined : v; }); } })),
          rangeRow('Opacity', +(cur.opacity ?? smp.opacity).toFixed(2), 0.02, 1, 0.01, (n) => this.editDetected(d, (x) => { x.opacity = Math.abs(n - smp.opacity) < 1e-3 ? undefined : n; }), true),
          colorRow('Colour', cur.color ?? smp.color, (c) => this.editDetected(d, (x) => { x.color = c; })),
          h('div', { class: 'row' }, h('label', {}, 'Size %'), h('input', { type: 'number', step: '5', value: String(Math.round((cur.scale ?? 1) * 100)), onchange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value) / 100; this.editDetected(d, (x) => { x.scale = v > 0 && Math.abs(v - 1) > 1e-3 ? v : undefined; }); } })),
          h('div', { class: 'row' }, h('label', {}, 'Angle°'), h('input', { type: 'number', step: '1', value: String(Math.round(smp.angle + (cur.rotate ?? 0))), onchange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value) - smp.angle; this.editDetected(d, (x) => { x.rotate = Math.abs(v) > 0.01 ? v : undefined; }); } })),
          h('div', { class: 'hint', style: 'margin-bottom:6px' }, `Edited in place on every page${smp.font ? ` with its own font (${smp.font})` : ''}.`),
        );
      }
      card.append(h('div', { class: 'btns' },
        removed
          ? h('button', { class: 'btn small', onclick: () => this.setRemoved(d, false) }, 'Restore')
          : h('button', { class: 'btn small danger', onclick: () => this.setRemoved(d, true) }, icon('trash'), `Remove from ${d.hits.length} page${d.hits.length > 1 ? 's' : ''}`),
        h('button', { class: 'btn small', onclick: () => this.revealHit(d) }, 'Show'),
        !removed && d.sample ? h('button', { class: 'btn small', onclick: () => {
          const smp = d.sample!;
          const w = this.newWatermark('text', { text: smp.text, size: smp.size, angle: smp.angle, color: smp.color, opacity: smp.opacity, font: /bold/i.test(smp.font) ? 'Helvetica-Bold' : 'Helvetica' });
          this.setRemoved(d, true);
          this.commit((s) => { s.watermarks.push(w); });
          this.wmOpen = w.id;
          this.renderTabs();
        } }, 'Replace with new…') : null,
        editable && Object.keys(cur).length ? h('button', { class: 'btn small', onclick: () => this.commit((s) => { for (const x of d.hits) for (const gid of x.groupIds) delete s.textEdits[x.key]?.[gid]; }) }, 'Reset') : null,
      ));
      det.append(card);
    }
    b.append(det);

    // --- added watermarks
    const add = h('div', { class: 'sec' }, h('h4', {}, 'Your watermarks'),
      h('div', { class: 'btns', style: 'margin-bottom:10px' },
        h('button', { class: 'btn small primary', onclick: () => { const w = this.newWatermark('text'); this.commit((s) => { s.watermarks.push(w); }); this.wmOpen = w.id; this.renderTabs(); } }, icon('plus'), 'Text watermark'),
        h('button', { class: 'btn small', onclick: async () => {
          const [f] = await pickFiles('image/png,image/jpeg');
          if (!f) return;
          const a: Asset = { id: uid('a'), kind: /png/i.test(f.type) || /\.png$/i.test(f.name) ? 'png' : 'jpg', name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
          this.assets.set(a.id, a);
          const w = this.newWatermark('image', { asset: a.id, text: f.name });
          this.commit((s) => { s.watermarks.push(w); });
          this.wmOpen = w.id;
          this.renderTabs();
        } }, icon('image'), 'Image / logo')));
    if (!this.state.watermarks.length) add.append(h('div', { class: 'hint' }, 'Watermarks you add stay editable here – change the text, angle, opacity or pages any time, even after re-opening the exported file (they are tagged as standard PDF watermark artifacts).'));
    for (const w of this.state.watermarks) {
      const open = this.wmOpen === w.id;
      const card = h('div', { class: 'match', style: 'cursor:default' },
        h('div', { style: 'display:flex;gap:8px;align-items:center' },
          h('input', { type: 'checkbox', checked: w.enabled, title: 'Show / hide', onchange: (e: Event) => this.updWm(w.id, (x) => { x.enabled = (e.target as HTMLInputElement).checked; }) }),
          h('b', { style: 'background:none;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, w.kind === 'image' ? `🖼 ${w.text}` : w.text || '(empty)'),
          h('button', { class: 'btn small', onclick: () => { this.wmOpen = open ? null : w.id; this.renderTabs(); } }, open ? 'Done' : 'Edit'),
          h('button', { class: 'btn small icon', title: 'Duplicate', onclick: () => this.commit((s) => { s.watermarks.push({ ...structuredClone(w), id: uid('w') }); }) }, icon('plus')),
          h('button', { class: 'btn small icon danger', title: 'Delete', onclick: () => this.commit((s) => { s.watermarks = s.watermarks.filter((x) => x.id !== w.id); }) }, icon('trash'))),
        h('div', { class: 'pg', style: 'margin-top:4px' }, `${w.position} · ${w.angle}° · ${Math.round(w.opacity * 100)}% · ${w.layer === 'under' ? 'behind content' : 'over content'} · ${w.pages ? 'pages ' + w.pages : 'all pages'}`));
      if (open) {
        const f = h('div', { style: 'margin-top:10px' });
        if (w.kind === 'text') f.append(
          h('div', { class: 'row' }, h('label', {}, 'Text'), h('input', { type: 'text', value: w.text, onchange: (e: Event) => this.updWm(w.id, (x) => { x.text = (e.target as HTMLInputElement).value; }) })),
          fontRow(w.font, this.assets, (v) => this.updWm(w.id, (x) => { x.font = v; })),
          numRow('Size', w.size, (n) => this.updWm(w.id, (x) => { x.size = n; })),
          colorRow('Colour', w.color, (c) => this.updWm(w.id, (x) => { x.color = c; })),
          !w.font.startsWith('asset:') && unsupportedStandardChars(w.text).length ? h('div', { class: 'pill warn', style: 'margin-bottom:8px;white-space:normal' }, `${unsupportedStandardChars(w.text).join(' ')} need an uploaded font`) : '',
        );
        else f.append(rangeRow('Width %', Math.round((w.imageScale ?? 0.5) * 100), 5, 150, 1, (n) => this.updWm(w.id, (x) => { x.imageScale = n / 100; }), true));
        f.append(
          rangeRow('Opacity', w.opacity, 0.02, 1, 0.01, (n) => this.updWm(w.id, (x) => { x.opacity = n; }), true),
          rangeRow('Angle°', w.angle, -90, 90, 1, (n) => this.updWm(w.id, (x) => { x.angle = n; }), true),
          h('div', { class: 'row' }, h('label', {}, 'Position'), h('select', { onchange: (e: Event) => this.updWm(w.id, (x) => { x.position = (e.target as HTMLSelectElement).value as WatermarkPosition; }) },
            ...(['center', 'tile', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((p) => h('option', { value: p, selected: w.position === p }, p)))),
          w.position === 'tile' ? rangeRow('Spacing', w.gap ?? 1, 0.5, 3, 0.1, (n) => this.updWm(w.id, (x) => { x.gap = n; }), true) : '',
          h('div', { class: 'row' }, h('label', {}, 'Layer'), h('select', { onchange: (e: Event) => this.updWm(w.id, (x) => { x.layer = (e.target as HTMLSelectElement).value as 'over'; }) },
            h('option', { value: 'over', selected: w.layer === 'over' }, 'Over content'), h('option', { value: 'under', selected: w.layer === 'under' }, 'Behind content'))),
          h('div', { class: 'row' }, h('label', {}, 'Pages'), h('input', { type: 'text', placeholder: 'all  (e.g. 1-3, 5, odd)', value: w.pages, onchange: (e: Event) => this.updWm(w.id, (x) => { x.pages = (e.target as HTMLInputElement).value; }) })),
        );
        card.append(f);
      }
      add.append(card);
    }
    b.append(add);
  }

  revealHit(d: DetectedWatermark) {
    const hit = d.hits[0];
    const i = this.state.pages.findIndex((p) => p.key === hit.key);
    if (i < 0) return;
    const v = this.views[i];
    const r = this.rectPx(v, hit.bbox.x0, hit.bbox.y0, hit.bbox.x1, hit.bbox.y1);
    this.viewer.scrollTo({ top: v.el.offsetTop + r.top - 80, behavior: 'smooth' });
    const flash = h('div', { class: 'draft', style: `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-color:#f5b942;background:#f5b94233` });
    v.layer.appendChild(flash);
    setTimeout(() => flash.remove(), 1600);
  }

  // ---------------- forms ----------------
  renderForms() {
    const b = this.tabbody;
    if (!this.fields.length) {
      b.append(h('div', { class: 'hint' }, 'This document has no fillable form fields. Use the Add text tool to type anywhere on the page.'));
      return;
    }
    const sec = h('div', { class: 'sec' }, h('h4', {}, 'Form fields'));
    for (const f of this.fields) {
      const val = this.state.forms[f.name] ?? f.value;
      const set = (v: string | boolean) => this.commit((s) => { s.forms[f.name] = v; });
      let input: HTMLElement;
      if (f.type === 'checkbox') input = h('input', { type: 'checkbox', checked: !!val, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
      else if (f.type === 'dropdown' || f.type === 'list' || f.type === 'radio')
        input = h('select', { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, h('option', { value: '' }, '—'), ...(f.options ?? []).map((o) => h('option', { value: o, selected: o === val }, o)));
      else if (f.type === 'text') input = f.multiline ? h('textarea', { value: String(val ?? ''), onchange: (e: Event) => set((e.target as HTMLTextAreaElement).value) }) : h('input', { type: 'text', value: String(val ?? ''), onchange: (e: Event) => set((e.target as HTMLInputElement).value) });
      else input = h('span', { class: 'muted' }, f.type);
      sec.append(h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:4px' }, h('label', { style: 'width:auto' }, f.name), input));
    }
    sec.append(h('label', { class: 'row', style: 'gap:8px' }, h('input', { type: 'checkbox', checked: this.state.flattenForms, onchange: (e: Event) => this.commit((s) => { s.flattenForms = (e.target as HTMLInputElement).checked; }) }), 'Flatten fields on export (make them permanent)'));
    b.append(sec);
  }

  // ---------------- document ----------------
  renderDoc() {
    const b = this.tabbody;
    const src = this.sources.get(this.primaryId)!;
    const d = src.doc;
    const m = this.state.meta;
    const metaRow = (label: string, k: keyof typeof m, cur: string | undefined) =>
      h('div', { class: 'row' }, h('label', {}, label), h('input', { type: 'text', value: m[k] ?? cur ?? '', onchange: (e: Event) => this.commit((s) => { s.meta[k] = (e.target as HTMLInputElement).value; }) }));
    b.append(h('div', { class: 'sec' }, h('h4', {}, 'Export'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn primary small', onclick: () => this.exportPdf('lossless') }, icon('save'), 'Lossless PDF'),
        h('button', { class: 'btn small', onclick: () => this.exportPdf('compact') }, 'Rebuilt & compact'),
        h('button', { class: 'btn small', onclick: () => this.exportPdf('compat') }, 'Max compatibility'),
        h('button', { class: 'btn small', onclick: () => this.exportPng() }, icon('png'), 'Page as PNG')),
      h('div', { class: 'hint', style: 'margin-top:8px' }, h('b', {}, 'Lossless'), ' keeps every byte of the original file and appends only your changes (incremental update) – images, fonts, colour profiles and everything you didn\'t touch stay bit-identical. ', h('b', {}, 'Rebuilt'), ' rewrites the file compactly with the same content.')));
    b.append(h('div', { class: 'sec' }, h('h4', {}, 'Fonts'),
      h('label', { class: 'row', style: 'gap:8px;align-items:flex-start' },
        h('input', { type: 'checkbox', checked: this.autoFonts, onchange: (e: Event) => { this.autoFonts = (e.target as HTMLInputElement).checked; try { localStorage.setItem('dpe.autoFonts', this.autoFonts ? '1' : '0'); } catch { /* ignore */ } if (this.autoFonts) this.autoMatchEdits(); } }),
        h('span', { class: 'hint' }, 'Automatically match fonts: when you type a character the PDF\'s font doesn\'t contain, fetch the real typeface (or its metric-identical twin for Arial, Times New Roman, Calibri…) from Fontsource, once, cached for offline use. Only the font name is sent – never your document.'))));
    if (this.report) {
      const r = this.report;
      b.append(h('div', { class: 'sec' }, h('h4', {}, 'Smart scan'), h('div', { class: 'kv' },
        h('div', {}, 'Text lines'), h('div', {}, String(r.textLines)),
        h('div', {}, 'Images'), h('div', {}, String(r.images)),
        h('div', {}, 'Fonts'), h('div', {}, String(r.fonts)),
        h('div', {}, 'Watermarks'), h('div', {}, String(r.watermarks.length)),
        h('div', {}, 'Scanned pages'), h('div', {}, r.scannedPages.length ? r.scannedPages.join(', ') : 'none'),
        h('div', {}, 'OCR text layer'), h('div', {}, r.invisibleTextPages.length ? 'pages ' + r.invisibleTextPages.join(', ') : 'none'))));
    }
    b.append(h('div', { class: 'sec' }, h('h4', {}, 'Metadata'),
      metaRow('Title', 'title', d.getTitle()), metaRow('Author', 'author', d.getAuthor()), metaRow('Subject', 'subject', d.getSubject()), metaRow('Keywords', 'keywords', d.getKeywords())));
    // font inventory
    const fonts = new Map<string, { name: string; type: string; emb: string }>();
    this.state.pages.forEach((slot) => {
      for (const g of this.groupsOf(slot.key)) {
        const f = g.runs[0].font;
        fonts.set(f.baseFont + f.subtype, { name: f.displayName, type: f.subtype, emb: f.embedded ? (f.isSubset ? 'subset' : 'full') : 'not embedded' });
      }
    });
    const edits = Object.values(this.state.textEdits).reduce((n, x) => n + Object.keys(x).length, 0);
    const ovs = Object.values(this.state.overlays).reduce((n, x) => n + x.length, 0);
    b.append(h('div', { class: 'sec' }, h('h4', {}, 'Summary'), h('div', { class: 'kv' },
      h('div', {}, 'File'), h('div', {}, this.fileName),
      h('div', {}, 'Pages'), h('div', {}, String(this.state.pages.length)),
      h('div', {}, 'Text edits'), h('div', {}, String(edits)),
      h('div', {}, 'Annotations'), h('div', {}, String(ovs)),
      h('div', {}, 'Output size'), h('div', {}, this.builtBytes ? `${(this.builtBytes.length / 1024).toFixed(1)} KB` : '—'),
      h('div', {}, 'PDF version'), h('div', {}, new TextDecoder().decode(src.info.bytes.subarray(0, 8)).replace('%', '')),
    )));
    b.append(h('div', { class: 'sec' }, h('h4', {}, `Fonts (${fonts.size})`),
      ...[...fonts.values()].map((f) => h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', {}, f.name), h('span', { class: `pill ${f.emb === 'not embedded' ? 'warn' : 'info'}` }, `${f.type} · ${f.emb}`))),
      fonts.size ? null : h('div', { class: 'hint' }, 'Scroll through the document (or use Find) to analyse more pages.')));
  }

  // ---------------- export ----------------
  async exportPdf(mode: 'lossless' | 'compact' | 'compat' = 'lossless') {
    if (!this.primaryId) return;
    this.setStatus('Exporting…', true);
    try {
      const bytes = await buildPdf(this.sources, this.primaryId, this.state, this.assets, { incremental: mode === 'lossless', compat: mode === 'compat' });
      const name = this.fileName.replace(/\.pdf$/i, '') + (this.undoStack.length ? '-edited' : '') + '.pdf';
      download(bytes, name);
      toast(`Exported ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
      this.setStatus('Exported');
    } catch (e) {
      console.error(e);
      toast('Export failed: ' + (e as Error).message, true, 5000);
    }
  }

  async exportPng() {
    const v = this.views[this.currentPage];
    if (!v?.page) return;
    const vp = v.page.getViewport({ scale: 3 });
    const c = h('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    await v.page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    c.toBlob((b) => b && download(b, `${this.fileName.replace(/\.pdf$/i, '')}-page${v.index + 1}.png`, 'image/png'), 'image/png');
  }
}

// =========================================================================
// helpers
// =========================================================================
function colorRow(label: string, c: RGB, set: (c: RGB) => void) {
  return h('div', { class: 'row' }, h('label', {}, label), h('input', { type: 'color', value: rgbToHex(c), onchange: (e: Event) => set(hexToRgb((e.target as HTMLInputElement).value)) }));
}
function numRow(label: string, n: number, set: (n: number) => void) {
  return h('div', { class: 'row' }, h('label', {}, label), h('input', { type: 'number', value: String(n), step: '0.5', min: '1', onchange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); if (v > 0) set(v); } }));
}
function rangeRow(label: string, n: number, min: number, max: number, step: number, set: (n: number) => void, onChangeOnly = false) {
  const out = h('span', { class: 'muted', style: 'width:34px;text-align:right' }, String(n));
  const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(n) });
  inp.addEventListener('input', () => { out.textContent = inp.value; if (!onChangeOnly) set(parseFloat(inp.value)); });
  inp.addEventListener('change', () => { if (onChangeOnly) set(parseFloat(inp.value)); });
  return h('div', { class: 'row' }, h('label', {}, label), inp, out);
}
function fontRow(cur: string, assets: Map<string, Asset>, set: (f: string) => void, label = 'Font', withAuto = false) {
  const opts = (withAuto ? [h('option', { value: '', selected: !cur }, 'Automatic (closest match)')] : []).concat(STANDARD_FONT_NAMES.filter((n) => n !== 'Symbol' && n !== 'ZapfDingbats').map((n) => h('option', { value: n, selected: n === cur }, n)));
  for (const a of assets.values()) if (a.kind === 'font') opts.push(h('option', { value: 'asset:' + a.id, selected: cur === 'asset:' + a.id }, `★ ${a.name}`));
  return h('div', { class: 'row' }, h('label', {}, label), h('select', { onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...opts));
}

export function fillToRgb(c: FillColor): RGB {
  const v = c.comps;
  if (v.length === 1) return [v[0], v[0], v[0]];
  if (v.length === 3) return [v[0], v[1], v[2]];
  if (v.length === 4) return [(1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])];
  return [0, 0, 0];
}

/** quote characters so punctuation like "," is readable in messages */
function quoteChars(chars: string[]) {
  const names: Record<string, string> = { ',': 'comma', '.': 'full stop', ';': 'semicolon', ':': 'colon', "'": 'apostrophe', '"': 'quote', '-': 'hyphen', ' ': 'space' };
  return [...new Set(chars)].map((c) => `“${c}”${names[c] ? ` (${names[c]})` : ''}`).join(', ');
}

function prettyFont(n: string) {
  if (n === 'automatic') return 'automatic closest match';
  return n.split(', ').map((x) => x.replace(/^bundled:/, '').replace(/^DejaVu/, 'DejaVu ')).join(', ');
}

function cssFontFamily(name: string, serif: boolean): string {
  const n = name.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0];
  const generic = /courier|mono|consol/i.test(name) ? 'monospace' : serif || /times|serif|roman|georgia|garamond|cambria/i.test(name) && !/sans/i.test(name) ? 'serif' : 'sans-serif';
  const alias = /helvetica|arial/i.test(name) ? 'Helvetica, Arial' : /times/i.test(name) ? '"Times New Roman", Times' : /courier/i.test(name) ? '"Courier New", Courier' : '';
  return `"${n}", ${alias ? alias + ', ' : ''}${generic}`;
}

function moveOverlay(o: Overlay, dx: number, dy: number) {
  o.x += dx;
  o.y += dy;
  if (o.type === 'line' || o.type === 'arrow') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
  if (o.type === 'ink') o.points = o.points.map((s) => s.map((v, i) => v + (i % 2 ? dy : dx)));
}

function resizeOverlay(o: Overlay, r: { x: number; y: number; w: number; h: number }) {
  const sx = o.w ? r.w / o.w : 1, sy = o.h ? r.h / o.h : 1;
  const mapX = (x: number) => r.x + (x - o.x) * sx;
  const mapY = (y: number) => r.y + (y - o.y) * sy;
  if (o.type === 'line' || o.type === 'arrow') { o.x1 = mapX(o.x1); o.x2 = mapX(o.x2); o.y1 = mapY(o.y1); o.y2 = mapY(o.y2); }
  if (o.type === 'ink') o.points = o.points.map((s) => s.map((v, i) => (i % 2 ? mapY(v) : mapX(v))));
  if (o.type === 'text') o.size = Math.max(2, o.size * Math.sqrt(sx * sy));
  Object.assign(o, r);
}

function fitInk(o: Overlay & { type: 'ink' }) {
  const xs: number[] = [], ys: number[] = [];
  for (const s of o.points) for (let i = 0; i < s.length; i += 2) { xs.push(s[i]); ys.push(s[i + 1]); }
  const pad = o.lineWidth;
  o.x = Math.min(...xs) - pad; o.y = Math.min(...ys) - pad;
  o.w = Math.max(...xs) - o.x + pad; o.h = Math.max(...ys) - o.y + pad;
}
function fitLine(o: Overlay & { type: 'line' | 'arrow' }) {
  const pad = Math.max(3, o.lineWidth * 2);
  o.x = Math.min(o.x1, o.x2) - pad; o.y = Math.min(o.y1, o.y2) - pad;
  o.w = Math.abs(o.x2 - o.x1) + 2 * pad; o.h = Math.abs(o.y2 - o.y1) + 2 * pad;
}

/** Measure a text overlay (view-oriented width/height in pt). */
const measureCanvas = document.createElement('canvas').getContext('2d')!;
function measureOverlay(o: TextOverlay, assets: Map<string, Asset>): { W: number; H: number } {
  const lines = (o.text || ' ').split('\n');
  let W = 0;
  if (!o.font.startsWith('asset:') && STANDARD_FONT_NAMES.includes(o.font)) {
    const f = StdFont.load(o.font as IFontNames);
    for (const l of lines) {
      let w = 0;
      for (const ch of l) {
        const cp = ch.codePointAt(0)!;
        const name = Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp) ? Encodings.WinAnsi.encodeUnicodeCodePoint(cp).name : 'question';
        w += f.getWidthOfGlyph(name) ?? 500;
      }
      W = Math.max(W, (w * o.size) / 1000);
    }
  } else {
    const fam = o.font.startsWith('asset:') && assets.has(o.font.slice(6)) ? `"${o.font}"` : 'sans-serif';
    measureCanvas.font = `${o.size}px ${fam}`;
    for (const l of lines) W = Math.max(W, measureCanvas.measureText(l).width);
  }
  const H = o.size * 1.2 * (lines.length - 1) + o.size * 1.15;
  return { W: Math.max(W, o.size * 0.5), H };
}

/** user-space point of the overlay's view-top-left corner */
function topLeftOf(o: { x: number; y: number; w: number; h: number; rot: number }): [number, number] {
  const { m } = uprightFrame(o);
  return [m[4], m[5]];
}
/** set overlay rect so that its view-top-left stays at tl with view size W×H */
function setTextBox(o: TextOverlay, tl: [number, number], { W, H }: { W: number; H: number }) {
  const r = ((o.rot % 360) + 360) % 360;
  const w = r % 180 === 0 ? W : H, hh = r % 180 === 0 ? H : W;
  const [tx, ty] = tl;
  if (r === 90) Object.assign(o, { x: tx, y: ty, w, h: hh });
  else if (r === 180) Object.assign(o, { x: tx - w, y: ty, w, h: hh });
  else if (r === 270) Object.assign(o, { x: tx - w, y: ty - hh, w, h: hh });
  else Object.assign(o, { x: tx, y: ty - hh, w, h: hh });
}

function imageSize(bytes: Uint8Array, kind: 'png' | 'jpg'): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: kind === 'png' ? 'image/png' : 'image/jpeg' }));
    const img = new Image();
    img.onload = () => { res({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => res({ w: 400, h: 300 });
    img.src = url;
  });
}

void StandardFonts;
