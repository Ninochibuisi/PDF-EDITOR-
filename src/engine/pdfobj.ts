/** Small helpers for walking pdf-lib's object model. */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';

export function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  let cur = o;
  for (let i = 0; i < 32 && cur instanceof PDFRef; i++) cur = ctx.lookup(cur);
  return cur;
}

export function dictGet(ctx: PDFContext, d: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!d) return undefined;
  return resolve(ctx, d.get(PDFName.of(key)));
}

export function getDict(ctx: PDFContext, d: PDFDict | undefined, key: string): PDFDict | undefined {
  const v = dictGet(ctx, d, key);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

export function getArray(ctx: PDFContext, d: PDFDict | undefined, key: string): PDFArray | undefined {
  const v = dictGet(ctx, d, key);
  return v instanceof PDFArray ? v : undefined;
}

export function getNum(ctx: PDFContext, d: PDFDict | undefined, key: string): number | undefined {
  const v = dictGet(ctx, d, key);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

export function getName(ctx: PDFContext, d: PDFDict | undefined, key: string): string | undefined {
  const v = dictGet(ctx, d, key);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function arrNums(ctx: PDFContext, a: PDFArray | undefined): number[] {
  if (!a) return [];
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const v = resolve(ctx, a.get(i));
    out.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  return out;
}

export function streamBytes(ctx: PDFContext, o: PDFObject | undefined): Uint8Array | undefined {
  const s = resolve(ctx, o);
  if (s instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(s).decode();
    } catch {
      return undefined;
    }
  }
  if (s instanceof PDFStream) {
    try {
      return (s as unknown as { getContents(): Uint8Array }).getContents();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function pdfStringBytes(o: PDFObject | undefined): Uint8Array | undefined {
  if (o instanceof PDFHexString) return o.asBytes();
  if (o instanceof PDFString) return o.asBytes();
  return undefined;
}

export function refKey(o: PDFObject | undefined): string {
  return o instanceof PDFRef ? `${o.objectNumber}_${o.generationNumber}` : 'direct';
}
