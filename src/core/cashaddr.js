// CashAddr (Bitcoin Cash address format) and legacy base58 conversion.
// Spec: https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md
import { bech32, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
const base58check = createBase58check(sha256);

// type: 0 P2PKH, 1 P2SH, 2 P2PKH with CashTokens, 3 P2SH with CashTokens.
export const CASHADDR_TYPES = { p2pkh: 0, p2sh: 1, 'p2pkh-token': 2, 'p2sh-token': 3 };
const HASH_SIZES = [160, 192, 224, 256, 320, 384, 448, 512];

function polymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATOR[i];
  }
  return c ^ 1n;
}

const prefixData = (prefix) => [...prefix].map((ch) => ch.charCodeAt(0) & 31);

export function encodeCashAddr(prefix, type, hash) {
  const sizeCode = HASH_SIZES.indexOf(hash.length * 8);
  if (sizeCode < 0 || type < 0 || type > 15) throw new Error('cashaddr: bad hash size or type');
  const payload = bech32.toWords(Uint8Array.from([(type << 3) | sizeCode, ...hash]));
  const chk = polymod([...prefixData(prefix), 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
  const checksum = Array.from({ length: 8 }, (_, i) => Number((chk >> BigInt(5 * (7 - i))) & 31n));
  return `${prefix}:${[...payload, ...checksum].map((v) => CHARSET[v]).join('')}`;
}

/**
 * Decodes "bitcoincash:q…" (or just "q…", using defaultPrefix). Returns { prefix, type, hash }
 * or null when the string is not a valid CashAddr.
 */
export function decodeCashAddr(text, defaultPrefix) {
  const s = String(text ?? '').trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf(':');
  const prefix = sep >= 0 ? lower.slice(0, sep) : defaultPrefix;
  const body = sep >= 0 ? lower.slice(sep + 1) : lower;
  if (!prefix || !/^[a-z]+$/.test(prefix) || body.length < 8) return null;
  const values = [];
  for (const ch of body) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    values.push(v);
  }
  if (polymod([...prefixData(prefix), 0, ...values]) !== 0n) return null;
  let bytes;
  try {
    bytes = bech32.fromWords(values.slice(0, -8));
  } catch {
    return null;
  }
  const version = bytes[0];
  if (version & 0x80) return null;
  const hash = bytes.slice(1);
  if (HASH_SIZES[version & 7] !== hash.length * 8) return null;
  return { prefix, type: version >> 3, hash };
}

/** Legacy base58 address → { version, hash } (or null). */
export function decodeBase58Address(text) {
  try {
    const raw = base58check.decode(String(text ?? '').trim());
    return raw.length === 21 ? { version: raw[0], hash: raw.slice(1) } : null;
  } catch {
    return null;
  }
}

export const encodeBase58Address = (version, hash) => base58check.encode(Uint8Array.from([version, ...hash]));
