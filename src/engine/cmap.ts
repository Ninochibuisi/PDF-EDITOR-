/**
 * Parser for ToUnicode and embedded (CID) CMaps.
 */
import { Lexer } from './lexer.ts';

export interface CodespaceRange {
  len: number;
  lo: number;
  hi: number;
}

export interface ParsedCMap {
  codespace: CodespaceRange[];
  /** code -> unicode string */
  toUnicode: Map<number, string>;
  /** code -> CID */
  toCid: Map<number, number>;
  /** length of code in bytes, by code (for codes seen in mappings) */
  codeLen: Map<number, number>;
}

const bytesToInt = (b: Uint8Array) => {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
};

export function utf16beToString(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2 === 1) s += String.fromCharCode(b[b.length - 1]);
  return s;
}

function incString(dst: Uint8Array, k: number): string {
  // increment the last code unit of a UTF-16BE string by k
  const arr = Uint8Array.from(dst);
  let v = arr.length >= 2 ? (arr[arr.length - 2] << 8) | arr[arr.length - 1] : arr[0];
  v += k;
  if (arr.length >= 2) {
    arr[arr.length - 2] = (v >> 8) & 0xff;
    arr[arr.length - 1] = v & 0xff;
  } else arr[0] = v & 0xff;
  return utf16beToString(arr);
}

export function parseCMap(data: Uint8Array): ParsedCMap {
  const res: ParsedCMap = { codespace: [], toUnicode: new Map(), toCid: new Map(), codeLen: new Map() };
  const lx = new Lexer(data);
  type V = { k: 'str'; b: Uint8Array } | { k: 'num'; n: number } | { k: 'arr'; items: V[] } | { k: 'kw'; w: string };
  const read = (): V | null => {
    const t = lx.next();
    if (t.t === 'eof') return null;
    if (t.t === 'operand') {
      if (t.v.kind === 'str') return { k: 'str', b: t.v.bytes };
      if (t.v.kind === 'num') return { k: 'num', n: t.v.value };
      return { k: 'kw', w: '' };
    }
    if (t.t === 'op') return { k: 'kw', w: t.v };
    if (t.t === 'arrOpen') {
      const items: V[] = [];
      for (;;) {
        const lt = lx.pos;
        const n = lx.next();
        if (n.t === 'arrClose' || n.t === 'eof') break;
        lx.pos = lt;
        const v = read();
        if (!v) break;
        items.push(v);
      }
      return { k: 'arr', items };
    }
    return { k: 'kw', w: '' };
  };

  for (;;) {
    const v = read();
    if (!v) break;
    if (v.k !== 'kw') continue;
    switch (v.w) {
      case 'begincodespacerange': {
        for (;;) {
          const a = read();
          if (!a || (a.k === 'kw' && a.w === 'endcodespacerange')) break;
          const b = read();
          if (a.k === 'str' && b && b.k === 'str') {
            res.codespace.push({ len: a.b.length, lo: bytesToInt(a.b), hi: bytesToInt(b.b) });
          }
        }
        break;
      }
      case 'beginbfchar': {
        for (;;) {
          const a = read();
          if (!a || (a.k === 'kw' && a.w === 'endbfchar')) break;
          const b = read();
          if (a.k === 'str' && b && b.k === 'str') {
            const code = bytesToInt(a.b);
            res.toUnicode.set(code, utf16beToString(b.b));
            res.codeLen.set(code, a.b.length);
          }
        }
        break;
      }
      case 'beginbfrange': {
        for (;;) {
          const a = read();
          if (!a || (a.k === 'kw' && a.w === 'endbfrange')) break;
          const b = read();
          const c = read();
          if (a.k !== 'str' || !b || b.k !== 'str' || !c) continue;
          const lo = bytesToInt(a.b);
          const hi = bytesToInt(b.b);
          if (hi - lo > 65535) continue;
          for (let code = lo; code <= hi; code++) {
            let u: string | undefined;
            if (c.k === 'str') u = incString(c.b, code - lo);
            else if (c.k === 'arr') {
              const it = c.items[code - lo];
              if (it && it.k === 'str') u = utf16beToString(it.b);
            }
            if (u !== undefined) {
              res.toUnicode.set(code, u);
              res.codeLen.set(code, a.b.length);
            }
          }
        }
        break;
      }
      case 'begincidchar': {
        for (;;) {
          const a = read();
          if (!a || (a.k === 'kw' && a.w === 'endcidchar')) break;
          const b = read();
          if (a.k === 'str' && b && b.k === 'num') {
            const code = bytesToInt(a.b);
            res.toCid.set(code, b.n);
            res.codeLen.set(code, a.b.length);
          }
        }
        break;
      }
      case 'begincidrange': {
        for (;;) {
          const a = read();
          if (!a || (a.k === 'kw' && a.w === 'endcidrange')) break;
          const b = read();
          const c = read();
          if (a.k === 'str' && b && b.k === 'str' && c && c.k === 'num') {
            const lo = bytesToInt(a.b);
            const hi = bytesToInt(b.b);
            if (hi - lo > 65535) continue;
            for (let code = lo; code <= hi; code++) {
              res.toCid.set(code, c.n + code - lo);
              res.codeLen.set(code, a.b.length);
            }
          }
        }
        break;
      }
    }
  }
  return res;
}
