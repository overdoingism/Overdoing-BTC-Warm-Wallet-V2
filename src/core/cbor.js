// Minimal canonical CBOR (RFC 8949): unsigned/negative integers, byte strings, text, arrays,
// maps (as Map), tags and true/false/null. Enough for UR parts and the UR registry types.
export class Tagged {
  constructor(tag, value) {
    this.tag = tag;
    this.value = value;
  }
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

function head(major, n, out) {
  const v = BigInt(n);
  if (v < 24n) out.push((major << 5) | Number(v));
  else if (v < 0x100n) out.push((major << 5) | 24, Number(v));
  else if (v < 0x10000n) out.push((major << 5) | 25, Number(v >> 8n), Number(v & 255n));
  else if (v < 0x100000000n) out.push((major << 5) | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 255n)));
  else out.push((major << 5) | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 255n)));
}

function enc(value, out) {
  if (value === false) return out.push(0xf4);
  if (value === true) return out.push(0xf5);
  if (value === null) return out.push(0xf6);
  if (typeof value === 'number' || typeof value === 'bigint') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('cbor: only integers');
    return value < 0 ? head(1, -BigInt(value) - 1n, out) : head(0, value, out);
  }
  if (value instanceof Uint8Array) {
    head(2, value.length, out);
    for (const b of value) out.push(b);
    return;
  }
  if (typeof value === 'string') {
    const b = te.encode(value);
    head(3, b.length, out);
    for (const x of b) out.push(x);
    return;
  }
  if (Array.isArray(value)) {
    head(4, value.length, out);
    for (const v of value) enc(v, out);
    return;
  }
  if (value instanceof Map) {
    head(5, value.size, out);
    for (const [k, v] of value) {
      enc(k, out);
      enc(v, out);
    }
    return;
  }
  if (value instanceof Tagged) {
    head(6, value.tag, out);
    return enc(value.value, out);
  }
  throw new Error('cbor: unsupported value');
}

export function cborEncode(value) {
  const out = [];
  enc(value, out);
  return Uint8Array.from(out);
}

export function cborDecode(bytes) {
  let pos = 0;
  const need = (n) => {
    if (pos + n > bytes.length) throw new Error('cbor: truncated');
  };
  const readArg = (info) => {
    if (info < 24) return BigInt(info);
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!size) throw new Error('cbor: unsupported length');
    need(size);
    let v = 0n;
    for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(bytes[pos++]);
    return v;
  };
  const toNum = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
  const item = (depth) => {
    if (depth > 64) throw new Error('cbor: too deep');
    need(1);
    const ib = bytes[pos++];
    const major = ib >> 5;
    const info = ib & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error('cbor: unsupported simple value');
    }
    const arg = readArg(info);
    switch (major) {
      case 0:
        return toNum(arg);
      case 1:
        return toNum(-arg - 1n);
      case 2:
      case 3: {
        const n = Number(arg);
        need(n);
        const b = bytes.slice(pos, pos + n);
        pos += n;
        return major === 2 ? b : td.decode(b);
      }
      case 4: {
        const n = Number(arg);
        if (n > bytes.length) throw new Error('cbor: bad array length');
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        const n = Number(arg);
        if (n > bytes.length) throw new Error('cbor: bad map length');
        const m = new Map();
        for (let i = 0; i < n; i++) m.set(item(depth + 1), item(depth + 1));
        return m;
      }
      default:
        return new Tagged(toNum(arg), item(depth + 1));
    }
  };
  const value = item(0);
  if (pos !== bytes.length) throw new Error('cbor: trailing bytes');
  return value;
}
