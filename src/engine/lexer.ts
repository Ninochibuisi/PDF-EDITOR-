/**
 * Content-stream lexer/parser.
 *
 * Produces operations with exact byte offsets so that edits can be spliced
 * into the original stream without re-serialising anything we did not touch.
 * This is what keeps untouched content byte-identical on export.
 */

export type Operand =
  | { kind: 'num'; value: number }
  | { kind: 'str'; bytes: Uint8Array; hex: boolean }
  | { kind: 'name'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'array'; items: Operand[] }
  | { kind: 'dict'; entries: Record<string, Operand> };

export interface Operation {
  op: string;
  operands: Operand[];
  /** byte offset of the first operand (or the operator when there are none) */
  start: number;
  /** byte offset just after the operator */
  end: number;
  /** for inline images (BI ... ID ... EI) */
  inlineImage?: { dict: Record<string, Operand> };
}

const WS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const isWS = (c: number) => WS[c] === 1;
const isDelim = (c: number) => DELIM[c] === 1;
const isRegular = (c: number) => !isWS(c) && !isDelim(c);

type Tok =
  | { t: 'operand'; v: Operand; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }
  | { t: 'arrOpen'; s: number }
  | { t: 'arrClose'; e: number }
  | { t: 'dictOpen'; s: number }
  | { t: 'dictClose'; e: number }
  | { t: 'eof' };

export class Lexer {
  pos = 0;
  buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  private skipWS() {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWS(c)) this.pos++;
      else if (c === 0x25 /* % */) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  next(): Tok {
    this.skipWS();
    const b = this.buf;
    if (this.pos >= b.length) return { t: 'eof' };
    const s = this.pos;
    const c = b[s];
    if (c === 0x28 /* ( */) {
      const bytes = this.readLiteral();
      return { t: 'operand', v: { kind: 'str', bytes, hex: false }, s, e: this.pos };
    }
    if (c === 0x3c /* < */) {
      if (b[s + 1] === 0x3c) {
        this.pos += 2;
        return { t: 'dictOpen', s };
      }
      const bytes = this.readHex();
      return { t: 'operand', v: { kind: 'str', bytes, hex: true }, s, e: this.pos };
    }
    if (c === 0x3e /* > */) {
      this.pos += b[s + 1] === 0x3e ? 2 : 1;
      return { t: 'dictClose', e: this.pos };
    }
    if (c === 0x5b) {
      this.pos++;
      return { t: 'arrOpen', s };
    }
    if (c === 0x5d) {
      this.pos++;
      return { t: 'arrClose', e: this.pos };
    }
    if (c === 0x7b || c === 0x7d) {
      // braces only appear in PostScript calculator functions; treat as noise
      this.pos++;
      return this.next();
    }
    if (c === 0x2f /* / */) {
      this.pos++;
      let name = '';
      while (this.pos < b.length && isRegular(b[this.pos])) {
        const ch = b[this.pos];
        if (ch === 0x23 /* # */ && this.pos + 2 < b.length) {
          const hx = String.fromCharCode(b[this.pos + 1], b[this.pos + 2]);
          if (/^[0-9a-fA-F]{2}$/.test(hx)) {
            name += String.fromCharCode(parseInt(hx, 16));
            this.pos += 3;
            continue;
          }
        }
        name += String.fromCharCode(ch);
        this.pos++;
      }
      return { t: 'operand', v: { kind: 'name', value: name }, s, e: this.pos };
    }
    // number or keyword/operator
    let word = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      word += String.fromCharCode(b[this.pos]);
      this.pos++;
    }
    if (word.length === 0) {
      // stray delimiter, skip
      this.pos++;
      return this.next();
    }
    if (/^[+-]{0,2}(\d+\.?\d*|\.\d+)$/.test(word)) {
      return { t: 'operand', v: { kind: 'num', value: parseFloat(word) || 0 }, s, e: this.pos };
    }
    if (word === 'true' || word === 'false') {
      return { t: 'operand', v: { kind: 'bool', value: word === 'true' }, s, e: this.pos };
    }
    if (word === 'null') return { t: 'operand', v: { kind: 'null' }, s, e: this.pos };
    return { t: 'op', v: word, s, e: this.pos };
  }

  private readLiteral(): Uint8Array {
    const b = this.buf;
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c /* \ */) {
        c = b[this.pos++];
        switch (c) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x28: case 0x29: case 0x5c: out.push(c); break;
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++;
            break; // line continuation
          case 0x0a: break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let i = 0; i < 2; i++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  v = v * 8 + (d - 0x30);
                  this.pos++;
                } else break;
              }
              out.push(v & 0xff);
            } else if (c !== undefined) out.push(c);
        }
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
      }
      out.push(c);
    }
    return Uint8Array.from(out);
  }

  private readHex(): Uint8Array {
    const b = this.buf;
    this.pos++; // <
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      let v = -1;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    return Uint8Array.from(out);
  }

  /** After the ID operator: skip binary inline image data up to EI. */
  skipInlineImageData(): number {
    const b = this.buf;
    // single whitespace after ID
    if (isWS(b[this.pos])) this.pos++;
    for (let i = this.pos; i < b.length - 1; i++) {
      if (
        b[i] === 0x45 && b[i + 1] === 0x49 &&
        (i === 0 || isWS(b[i - 1])) &&
        (i + 2 >= b.length || isWS(b[i + 2]) || isDelim(b[i + 2]))
      ) {
        this.pos = i + 2;
        return this.pos;
      }
    }
    this.pos = b.length;
    return this.pos;
  }
}

/** Parse a whole content stream into operations. */
export function parseContent(buf: Uint8Array): Operation[] {
  const lx = new Lexer(buf);
  const ops: Operation[] = [];
  let operands: Operand[] = [];
  let opStart = -1;
  // stack for arrays/dicts
  const stack: { kind: 'array' | 'dict'; items: Operand[]; s: number }[] = [];

  const push = (v: Operand, s: number) => {
    if (stack.length) stack[stack.length - 1].items.push(v);
    else {
      if (opStart < 0) opStart = s;
      operands.push(v);
    }
  };

  for (;;) {
    const tk = lx.next();
    if (tk.t === 'eof') break;
    switch (tk.t) {
      case 'operand':
        push(tk.v, tk.s);
        break;
      case 'arrOpen':
      case 'dictOpen':
        stack.push({ kind: tk.t === 'arrOpen' ? 'array' : 'dict', items: [], s: tk.s });
        break;
      case 'arrClose':
      case 'dictClose': {
        const top = stack.pop();
        if (!top) break;
        let v: Operand;
        if (top.kind === 'array') v = { kind: 'array', items: top.items };
        else {
          const entries: Record<string, Operand> = {};
          for (let i = 0; i + 1 < top.items.length; i += 2) {
            const k = top.items[i];
            if (k.kind === 'name') entries[k.value] = top.items[i + 1];
          }
          v = { kind: 'dict', entries };
        }
        push(v, top.s);
        break;
      }
      case 'op': {
        if (stack.length) {
          // keyword inside array (malformed) – ignore
          break;
        }
        if (tk.v === 'BI') {
          // inline image: key/value pairs until ID
          const s = tk.s;
          const dictItems: Operand[] = [];
          for (;;) {
            const t2 = lx.next();
            if (t2.t === 'eof') break;
            if (t2.t === 'op' && t2.v === 'ID') break;
            if (t2.t === 'operand') dictItems.push(t2.v);
            else if (t2.t === 'arrOpen') {
              // arrays inside inline image dict (e.g. /D [1 0]) – collect simply
              const items: Operand[] = [];
              for (;;) {
                const t3 = lx.next();
                if (t3.t === 'arrClose' || t3.t === 'eof') break;
                if (t3.t === 'operand') items.push(t3.v);
              }
              dictItems.push({ kind: 'array', items });
            }
          }
          const end = lx.skipInlineImageData();
          const dict: Record<string, Operand> = {};
          for (let i = 0; i + 1 < dictItems.length; i += 2) {
            const k = dictItems[i];
            if (k.kind === 'name') dict[k.value] = dictItems[i + 1];
          }
          ops.push({ op: 'BI', operands: [], start: opStart >= 0 ? opStart : s, end, inlineImage: { dict } });
          operands = [];
          opStart = -1;
          break;
        }
        ops.push({ op: tk.v, operands, start: opStart >= 0 ? opStart : tk.s, end: tk.e });
        operands = [];
        opStart = -1;
        break;
      }
    }
  }
  return ops;
}

// ---------- serialisation helpers ----------

export function fmtNum(n: number): string {
  if (!isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(5);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export function hexString(bytes: Uint8Array | number[]): string {
  let s = '<';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s + '>';
}

export function nameToken(n: string): string {
  let s = '/';
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || isDelim(c) || c === 0x23) s += '#' + (c < 16 ? '0' : '') + c.toString(16);
    else s += ch;
  }
  return s;
}

export const latin1 = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
