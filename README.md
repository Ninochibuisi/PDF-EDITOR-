# Deep PDF Editor

A PDF editor that runs entirely in the browser. It edits the real text inside a PDF using the document's own embedded fonts, so edited text looks the same as the original. There is no server and no upload. The whole app, including the PDF engine, the pdf.js renderer and its worker, builds into **one self-contained HTML file**.

```
npm install
npm run dev        # develop at http://localhost:5173
npm run release    # → release/deep-pdf-editor.html (single file, works offline, double-click to open)
npm test           # engine round-trip, stress and quality tests (Node 22+; pixel checks use poppler if installed)
```

## What it does

| Area | Features |
|---|---|
| **Zero-drift fidelity** | Only the operators you edit are rewritten. Redrawn text is painted at its original spot in the content stream, inside the original graphics state, so colour space, exact shade, spot colours, transparency, blend mode, clipping and stacking order are inherited, not re-created. Tests check that every pixel outside an edited line is identical, and that edited text keeps its exact RGB colour. |
| **Lossless export** | The default export is an **incremental update**. Every byte of the original file is kept verbatim and only your changes are appended (PDF 1.5 xref streams supported). Images, fonts and ICC profiles stay bit-identical. A "rebuilt & compact" export is also available. |
| **Smart scan** | Every page is analysed in the background: text lines, fonts, images, watermarks, scanned (image-only) pages, and hidden OCR text layers. |
| **Watermark studio** | Detects tagged watermark artifacts, Adobe Acrobat watermarks, `/Watermark` annotations, and untagged look-alikes (diagonal, translucent, repeated, "CONFIDENTIAL"/"DRAFT"…). For each one you can **re-text it in place in its own font**, change its opacity, colour, size or angle across every page, remove it, or replace it. You can also add text or image watermarks (centred, tiled or in corners, over or behind content, on page ranges like `1-3, odd`). Added watermarks are tagged as standard PDF watermark artifacts, so they stay editable after the file is re-opened. |
| **Edit existing text** | Click any line to retype it. The new text is re-encoded into the PDF's content stream using the **original embedded font** (Type1, TrueType, CID/Type0, Type3, CJK). The rest of the line reflows. You can also move, resize, recolour or delete lines. |
| **Find & replace** | Searches the whole document and writes replacements back into the original text runs. |
| **Images & objects** | Move, delete or replace embedded images and vector form objects. |
| **Real redaction** | Removes the glyphs (character by character) and images under the box from the file itself, then paints the box. Covering the content is not enough. |
| **Annotate** | Text boxes (standard or uploaded TTF/OTF fonts), images, signatures (drawn or typed), rectangles, ellipses, lines, arrows, freehand ink, highlights, whiteout. |
| **Pages** | Merge PDFs, reorder by drag and drop, rotate, delete, insert blank pages, import images or `.txt` files as pages. |
| **Forms** | Fill AcroForm text fields, checkboxes, dropdowns and radio buttons; optionally flatten them. |
| **Document** | Edit metadata, list every font with its embedding status, export a page as PNG. |
| **Workflow** | Unlimited undo/redo, zoom, keyboard shortcuts, drag-and-drop files. |

## How the engine works (`src/engine`)

1. **`lexer.ts`**: a content-stream tokenizer that records the **exact byte offset** of every operator, including strings, hex strings, arrays, dicts and inline images.
2. **`interpreter.ts`**: tracks the graphics and text state the way a renderer does (CTM, `Tm`/`Tlm`, `Tc`, `Tw`, `Tz`, `TL`, `Ts`, `Tr`, fill colour, font). It records every `Tj`/`TJ`/`'`/`"` operator with its matrices, glyphs, advance and bounding box, and every image or form `Do`. Runs on the same baseline in the same font family are merged into editable lines.
3. **`fonts.ts`** + **`cmap.ts`**: decode shown bytes to Unicode and widths (ToUnicode CMaps, `/Encoding` + `/Differences`, standard encodings, CID `/W` arrays, Type3 `FontMatrix`). The **reverse map** turns new text back into the font's own character codes, including ligatures. For TrueType CID subsets it reads `loca`/`glyf` to confirm a glyph really exists in the embedded subset. Spaces missing from the font are emulated with `TJ` kerning, the way TeX does it. A line can switch between several subsets of the same family.
4. **`engine.ts`**: applies the declarative edit state to a fresh copy of the original bytes:
   * **In place**: the operator's byte range is replaced with new `TJ` operands. A kerning adjustment keeps everything after it exactly where it was, and the following runs on the same line slide by the width difference. All other bytes are left untouched.
   * **Restyle/move/rotate/opacity**: the original run is hidden (its advance is preserved). It is then redrawn **at the same place in the stream**: `ET q … BT … ET Q BT` with the text matrix restored afterwards. It uses the same font resource and inherits the colour and graphics state; only the property you changed is set.
   * **Missing glyph**: subset fonts only contain the characters the document already used. When you type a character that isn't there, that line falls back to a matching standard font, a font file you upload, or (in Chromium) **the same font installed on your computer** via *Match installed font*. The UI always tells you when this happens.
   * Page assembly, overlays, forms and metadata are done with pdf-lib.
5. **`watermarks.ts`**: the document-wide smart scan and watermark detector (marked-content `/Artifact /Watermark` blocks, Acrobat `PieceInfo` watermark forms, watermark annotations, and heuristics: rotation, opacity from `ExtGState`, size, colour, wording, centring, repetition across pages).
6. **Incremental writer** (`saveIncremental`): diffs every object against the pristine file and appends only the changed or new ones with a cross-reference table or stream that chains to the original (`/Prev`).

Each preview is built by the same code path as the export, so what you see is what you download.

## Honest limitations

* Editing works **line by line**. It does not reflow whole paragraphs across lines.
* Text inside Form XObjects (reusable vector objects) can be moved or deleted as an object, but not retyped.
* Encrypted PDFs open for viewing; their content cannot be rewritten.
* Scanned pages are detected, but there is no OCR: their text is a picture. Existing hidden OCR text layers are editable.
* Word or other office formats are not converted. Export them to PDF first, then edit. Images and `.txt` files can be imported directly.
