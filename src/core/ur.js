// Uniform Resources (BCR-2020-005) with multi-part fountain codes, so data that does not fit
// one QR code can be shown as an animated sequence. Implemented from the Blockchain Commons
// spec and cross-checked part-for-part against @ngraveio/bc-ur in the tests.
import { sha256 } from '@noble/hashes/sha2.js';
import { cborDecode, cborEncode } from './cbor.js';

// ---------------------------------------------------------------- CRC32 (IEEE)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32be = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

// ---------------------------------------------------------------- Bytewords (minimal style)
const WORDS =
  'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';
const MINIMAL = Array.from({ length: 256 }, (_, i) => WORDS[i * 4] + WORDS[i * 4 + 3]);
const MINIMAL_INDEX = new Map(MINIMAL.map((w, i) => [w, i]));

export function bytewordsEncode(bytes) {
  const all = new Uint8Array(bytes.length + 4);
  all.set(bytes);
  all.set(u32be(crc32(bytes)), bytes.length);
  let s = '';
  for (const b of all) s += MINIMAL[b];
  return s;
}

export function bytewordsDecode(text) {
  const s = text.toLowerCase();
  if (s.length % 2 || s.length < 10) throw new Error('ur: bad bytewords length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = MINIMAL_INDEX.get(s.slice(i * 2, i * 2 + 2));
    if (v === undefined) throw new Error('ur: invalid byteword');
    out[i] = v;
  }
  const body = out.slice(0, -4);
  const sum = out.slice(-4);
  const expect = u32be(crc32(body));
  if (sum.some((b, i) => b !== expect[i])) throw new Error('ur: checksum mismatch');
  return body;
}

// ---------------------------------------------------------------- Xoshiro256** PRNG
const MASK64 = (1n << 64n) - 1n;
const rotl = (x, k) => ((x << BigInt(k)) | (x >> BigInt(64 - k))) & MASK64;

class Xoshiro {
  constructor(seed) {
    const d = sha256(seed);
    this.s = [0, 1, 2, 3].map((i) => {
      let v = 0n;
      for (let n = 0; n < 8; n++) v = (v << 8n) | BigInt(d[i * 8 + n]);
      return v;
    });
  }
  next() {
    const s = this.s;
    const result = (rotl((s[1] * 5n) & MASK64, 7) * 9n) & MASK64;
    const t = (s[1] << 17n) & MASK64;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 45);
    return result;
  }
  nextDouble() {
    return Number(this.next()) / 18446744073709551616;
  }
  nextInt(low, high) {
    return Math.floor(this.nextDouble() * (high - low + 1) + low);
  }
}

// Walker's alias method, laid out exactly like the reference implementation.
function aliasSampler(probs) {
  const n = probs.length;
  const sum = probs.reduce((a, b) => a + b, 0);
  const P = probs.map((p) => (p * n) / sum);
  const S = [];
  const L = [];
  for (let i = n - 1; i >= 0; i--) (P[i] < 1 ? S : L).push(i);
  const prob = new Array(n).fill(0);
  const alias = new Array(n).fill(0);
  while (S.length && L.length) {
    const a = S.pop();
    const g = L.pop();
    prob[a] = P[a];
    alias[a] = g;
    P[g] = P[g] + P[a] - 1;
    (P[g] < 1 ? S : L).push(g);
  }
  while (L.length) prob[L.pop()] = 1;
  while (S.length) prob[S.pop()] = 1;
  return (rng) => {
    const r1 = rng.nextDouble();
    const r2 = rng.nextDouble();
    const i = Math.floor(n * r1);
    return r2 < prob[i] ? i : alias[i];
  };
}

/** Indexes of the fragments XOR-ed into part `seqNum` (1-based). */
export function chooseFragments(seqNum, seqLen, checksum) {
  if (seqNum <= seqLen) return [seqNum - 1];
  const seed = new Uint8Array(8);
  seed.set(u32be(seqNum), 0);
  seed.set(u32be(checksum), 4);
  const rng = new Xoshiro(seed);
  const degree = aliasSampler(Array.from({ length: seqLen }, (_, i) => 1 / (i + 1)))(rng) + 1;
  const remaining = Array.from({ length: seqLen }, (_, i) => i);
  const shuffled = [];
  while (remaining.length) shuffled.push(remaining.splice(rng.nextInt(0, remaining.length - 1), 1)[0]);
  return shuffled.slice(0, degree);
}

function fragmentLength(messageLength, minLen, maxLen) {
  const maxCount = Math.ceil(messageLength / minLen);
  let len = 0;
  for (let count = 1; count <= maxCount; count++) {
    len = Math.ceil(messageLength / count);
    if (len <= maxLen) break;
  }
  return len;
}

const xorInto = (target, src) => {
  for (let i = 0; i < target.length; i++) target[i] ^= src[i];
};

// ---------------------------------------------------------------- encoder
const isUrType = (t) => /^[a-z0-9-]+$/.test(t);

/**
 * Encodes CBOR bytes as UR strings. nextPart() yields an endless sequence (the first seqLen
 * parts are the plain fragments, later ones are fountain-mixed), suitable for an animated QR.
 */
export class UREncoder {
  constructor(type, cbor, maxFragmentLength = 250, minFragmentLength = 10) {
    if (!isUrType(type)) throw new Error('ur: bad type');
    this.type = type;
    this.cbor = cbor;
    const len = fragmentLength(cbor.length, minFragmentLength, maxFragmentLength);
    this.fragments = [];
    for (let i = 0; i < cbor.length; i += len) {
      const f = new Uint8Array(len);
      f.set(cbor.slice(i, i + len));
      this.fragments.push(f);
    }
    this.checksum = crc32(cbor);
    this.seqNum = 0;
  }
  get isSinglePart() {
    return this.fragments.length === 1;
  }
  get seqLen() {
    return this.fragments.length;
  }
  nextPart() {
    if (this.isSinglePart) return `ur:${this.type}/${bytewordsEncode(this.cbor)}`;
    this.seqNum = (this.seqNum + 1) >>> 0;
    const mixed = new Uint8Array(this.fragments[0].length);
    for (const i of chooseFragments(this.seqNum, this.seqLen, this.checksum)) xorInto(mixed, this.fragments[i]);
    const part = cborEncode([this.seqNum, this.seqLen, this.cbor.length, this.checksum, mixed]);
    return `ur:${this.type}/${this.seqNum}-${this.seqLen}/${bytewordsEncode(part)}`;
  }
}

export const encodeSingleUR = (type, cbor) => `ur:${type}/${bytewordsEncode(cbor)}`;

// ---------------------------------------------------------------- decoder
/** Feeds UR strings (in any order, with repeats) until `result` = { type, cbor } is complete. */
export class URDecoder {
  constructor() {
    this.type = null;
    this.result = null;
    this.expected = null; // { seqLen, messageLength, checksum, fragmentLength }
    this.simple = new Map(); // index → fragment
    this.mixed = []; // { indexes: Set, data }
    this.queue = [];
  }

  /** Returns true when the part was accepted. Throws on malformed input. */
  receive(text) {
    if (this.result) return false;
    const s = String(text).trim().toLowerCase();
    if (!s.startsWith('ur:')) throw new Error('ur: not a UR');
    const comps = s.slice(3).split('/');
    const type = comps[0];
    if (!isUrType(type) || comps.length < 2 || comps.length > 3) throw new Error('ur: malformed');
    if (this.type && this.type !== type) return false;
    this.type = type;
    if (comps.length === 2) {
      this.result = { type, cbor: bytewordsDecode(comps[1]) };
      return true;
    }
    const m = comps[1].match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error('ur: bad sequence');
    const decoded = cborDecode(bytewordsDecode(comps[2]));
    if (!Array.isArray(decoded) || decoded.length !== 5) throw new Error('ur: bad part');
    const [seqNum, seqLen, messageLength, checksum, fragment] = decoded;
    if (seqNum !== Number(m[1]) || seqLen !== Number(m[2]) || !(fragment instanceof Uint8Array) || !fragment.length) throw new Error('ur: bad part');
    if (!this.expected) this.expected = { seqLen, messageLength, checksum, fragmentLength: fragment.length };
    const e = this.expected;
    if (e.seqLen !== seqLen || e.messageLength !== messageLength || e.checksum !== checksum || e.fragmentLength !== fragment.length) return false;
    this.queue.push({ indexes: new Set(chooseFragments(seqNum, seqLen, checksum)), data: Uint8Array.from(fragment) });
    while (!this.result && this.queue.length) this.#process(this.queue.shift());
    return true;
  }

  get progress() {
    if (this.result) return 1;
    return this.expected ? this.simple.size / this.expected.seqLen : 0;
  }

  #reduce(part, by) {
    for (const i of by.indexes) if (!part.indexes.has(i)) return part;
    const data = Uint8Array.from(part.data);
    xorInto(data, by.data);
    const indexes = new Set([...part.indexes].filter((i) => !by.indexes.has(i)));
    return { indexes, data };
  }

  #process(part) {
    if (part.indexes.size === 1) {
      const [index] = part.indexes;
      if (this.simple.has(index)) return;
      this.simple.set(index, part.data);
      if (this.simple.size === this.expected.seqLen) return this.#finish();
      const still = [];
      for (const m of this.mixed) {
        const r = this.#reduce(m, part);
        if (r.indexes.size === 1) this.queue.push(r);
        else still.push(r);
      }
      this.mixed = still;
      return;
    }
    const key = [...part.indexes].sort((a, b) => a - b).join(',');
    if (this.mixed.some((m) => [...m.indexes].sort((a, b) => a - b).join(',') === key)) return;
    let p = part;
    for (const [i, data] of this.simple) p = this.#reduce(p, { indexes: new Set([i]), data });
    for (const m of this.mixed) p = this.#reduce(p, m);
    if (p.indexes.size === 0) return;
    if (p.indexes.size === 1) {
      this.queue.push(p);
      return;
    }
    const still = [];
    for (const m of this.mixed) {
      const r = this.#reduce(m, p);
      if (r.indexes.size === 1) this.queue.push(r);
      else still.push(r);
    }
    this.mixed = [...still, p];
  }

  #finish() {
    const e = this.expected;
    const all = new Uint8Array(e.seqLen * e.fragmentLength);
    for (const [i, data] of this.simple) all.set(data, i * e.fragmentLength);
    const message = all.slice(0, e.messageLength);
    if (crc32(message) !== e.checksum) throw new Error('ur: message checksum mismatch');
    this.result = { type: this.type, cbor: message };
  }
}
