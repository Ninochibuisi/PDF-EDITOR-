/** Serializable editor state. Every edit is declarative, so undo/redo is a snapshot swap. */

export type RGB = [number, number, number];

export interface PageSlot {
  /** `${sourceId}:${pageIndex}` for real pages, `blank:${uid}` for inserted blanks */
  key: string;
  /** extra rotation applied on top of the page's own /Rotate */
  rotate: number;
  /** size for blank pages (pt) */
  size?: [number, number];
}

export interface TextEdit {
  text?: string;
  dx?: number;
  dy?: number;
  /** multiplier on the original font size */
  scale?: number;
  color?: RGB;
  deleted?: boolean;
  /** force a substitute font even if the original can encode the text */
  forceFallback?: boolean;
  /** standard font name or `asset:<id>` of an uploaded TTF/OTF */
  fallbackFont?: string;
  /** don't slide the rest of the line when the text width changes */
  noReflow?: boolean;
  /** new fill opacity (0..1); omitted = keep the original transparency exactly */
  opacity?: number;
  /** extra rotation in degrees (counter-clockwise) around the start of the baseline */
  rotate?: number;
}

export interface XObjectEdit {
  deleted?: boolean;
  dx?: number;
  dy?: number;
  /** asset id of a replacement image (drawn in the same box) */
  replaceAsset?: string;
}

interface OverlayBase {
  id: string;
  /** user-space box (PDF points, unrotated page coordinates) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** total page rotation at the time of creation – keeps text/images upright */
  rot: number;
  opacity?: number;
}

export interface TextOverlay extends OverlayBase {
  type: 'text';
  text: string;
  size: number;
  color: RGB;
  /** standard font name or `asset:<id>` */
  font: string;
  align?: 'left' | 'center' | 'right';
}
export interface ImageOverlay extends OverlayBase {
  type: 'image';
  asset: string;
}
export interface ShapeOverlay extends OverlayBase {
  type: 'rect' | 'ellipse' | 'highlight' | 'whiteout' | 'redact';
  stroke?: RGB | null;
  fill?: RGB | null;
  lineWidth?: number;
}
export interface LineOverlay extends OverlayBase {
  type: 'line' | 'arrow';
  /** endpoints in user space */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: RGB;
  lineWidth: number;
}
export interface InkOverlay extends OverlayBase {
  type: 'ink';
  points: number[][]; // list of strokes, each [x0,y0,x1,y1,...]
  stroke: RGB;
  lineWidth: number;
}

export type Overlay = TextOverlay | ImageOverlay | ShapeOverlay | LineOverlay | InkOverlay;

export interface DocMeta {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
}

export type WatermarkPosition = 'center' | 'tile' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** A watermark added by the editor (stays fully editable; tagged as a PDF watermark artifact). */
export interface Watermark {
  id: string;
  kind: 'text' | 'image';
  text: string;
  /** standard font name or `asset:<id>` */
  font: string;
  size: number;
  color: RGB;
  opacity: number;
  /** degrees, counter-clockwise as seen on screen */
  angle: number;
  position: WatermarkPosition;
  layer: 'over' | 'under';
  /** '' = all pages, otherwise e.g. "1-3, 7" (final page numbers) */
  pages: string;
  asset?: string;
  /** image width as a fraction of the page width */
  imageScale?: number;
  /** tile spacing multiplier */
  gap?: number;
  enabled: boolean;
}

export interface EditorState {
  pages: PageSlot[];
  textEdits: Record<string, Record<string, TextEdit>>;
  xobjEdits: Record<string, Record<string, XObjectEdit>>;
  overlays: Record<string, Overlay[]>;
  forms: Record<string, string | boolean | string[]>;
  /** content removed by the watermark manager: `group:<id>`, `xo:<id>`, `mc:<id>`, `annot:<ref>` per page key */
  removals: Record<string, string[]>;
  /** document-wide: font used for characters missing from an embedded font (keyed by its name) */
  fontMatches: Record<string, string>;
  watermarks: Watermark[];
  flattenForms: boolean;
  meta: DocMeta;
}

export interface Asset {
  id: string;
  kind: 'png' | 'jpg' | 'font';
  name: string;
  bytes: Uint8Array;
}

export const emptyState = (): EditorState => ({
  pages: [],
  textEdits: {},
  xobjEdits: {},
  overlays: {},
  forms: {},
  removals: {},
  fontMatches: {},
  watermarks: [],
  flattenForms: false,
  meta: {},
});

let uidCounter = 0;
export const uid = (p = 'id') => `${p}${Date.now().toString(36)}${(uidCounter++).toString(36)}`;
