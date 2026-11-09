# Deep PDF Editor

A PDF editor that runs entirely in the browser. It edits the real text inside a PDF using the document's own embedded fonts, so edited text looks the same as the original. There is no server and no upload. The whole app, including the PDF engine, the pdf.js renderer and its worker, builds into **one self-contained HTML file**.

```
npm install
npm run dev        # develop at http://localhost:5173
npm run release    # → release/deep-pdf-editor.html (single file, works offline, double-click to open)
npm test           # engine round-trip + stress tests (Node 22+)
```

## What it does

| Area | Features |
|---|---|
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
   * **Restyle/move**: the original run is hidden (its advance is preserved) and redrawn at the end of the page in the **same font resource**.
   * **Missing glyph**: subset fonts only contain the characters the document already used. When you type a character that isn't there, that line falls back to a matching standard font, a font file you upload, or (in Chromium) **the same font installed on your computer** via *Match installed font*. The UI always tells you when this happens.
   * Page assembly, overlays, forms and metadata are done with pdf-lib.

Each preview is built by the same code path as the export, so what you see is what you download.

## Honest limitations

* Editing works **line by line**. It does not reflow whole paragraphs across lines.
* Text inside Form XObjects (reusable vector objects) can be moved or deleted as an object, but not retyped.
* Encrypted PDFs open for viewing; their content cannot be rewritten.
* Word or other office formats are not converted. Export them to PDF first, then edit. Images and `.txt` files can be imported directly.
