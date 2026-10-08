import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { UR as NUR, UREncoder as NUREncoder, URDecoder as NURDecoder } from '@ngraveio/bc-ur';
import { URDecoder, UREncoder, bytewordsDecode, bytewordsEncode, chooseFragments, crc32 } from '../../src/core/ur.js';
import { Tagged, cborDecode, cborEncode } from '../../src/core/cbor.js';
import { accountToCbor, accountsFromUR, cborToPsbt, psbtToCbor } from '../../src/core/urtypes.js';
import { getNetwork } from '../../src/core/networks.js';
import { accountPath, hdAccountFromRoot, rootFromMnemonic } from '../../src/core/keys.js';

const vector = JSON.parse(readFileSync(new URL('../fixtures/bcr-2020-015-account.json', import.meta.url), 'utf8'));
const random = (n, seed) => {
  // Deterministic pseudo-random bytes so failures are reproducible.
  let x = seed >>> 0 || 1;
  return Uint8Array.from({ length: n }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 255);
};

describe('bytewords and CRC32', () => {
  it('matches the BCR-2020-012 example', () => {
    const payload = hex.decode('c7098580125e2ab0981253468b2dbc52');
    expect(crc32(payload).toString(16)).toBe('feac0dea');
    expect(bytewordsEncode(payload)).toBe('staslplabghydrpfmkbggufgludprfgmzepsbtwd');
    expect(bytewordsDecode('STASLPLABGHYDRPFMKBGGUFGLUDPRFGMZEPSBTWD')).toEqual(payload);
    expect(() => bytewordsDecode('staslplabghydrpfmkbggufgludprfgmzepsbtwe')).toThrow();
  });
});

describe('CBOR', () => {
  it('round-trips the value types we use', () => {
    const v = new Map([[1, 4294967295], [2, [new Tagged(308, new Uint8Array([1, 2]))]], [3, 'text'], [4, true], [5, -10], [6, 2n ** 60n]]);
    expect(cborDecode(cborEncode(v))).toEqual(v);
    expect(hex.encode(cborEncode([1, 2, 3, 4294967295, new Uint8Array([0xaa])]))).toBe('850102031affffffff41aa');
    expect(() => cborDecode(hex.decode('8501'))).toThrow();
  });
});

describe('fountain codes are identical to @ngraveio/bc-ur', () => {
  const cases = [[1, 250], [40, 10], [250, 250], [251, 250], [1000, 100], [3000, 250], [9000, 400]];
  it('produces the same parts', () => {
    for (const [len, maxFrag] of cases) {
      const cbor = cborEncode(random(len, len));
      const ours = new UREncoder('bytes', cbor, maxFrag);
      const theirs = new NUREncoder(new NUR(Buffer.from(cbor), 'bytes'), maxFrag, 0, 10);
      for (let i = 0; i < Math.max(3, ours.seqLen * 3); i++) expect(ours.nextPart(), `len ${len} part ${i}`).toBe(theirs.nextPart());
    }
  });

  it('chooses the same fragment sets for many sequence numbers', async () => {
    const { chooseFragments: theirs } = await import('@ngraveio/bc-ur/dist/fountainUtils.js');
    for (const seqLen of [2, 3, 5, 9, 17, 40, 101]) {
      for (let seq = 1; seq < 300; seq++) {
        const checksum = (seq * 2654435761) >>> 0;
        expect(chooseFragments(seq, seqLen, checksum)).toEqual(theirs(seq, seqLen, checksum));
      }
    }
  });

  it('decodes in either direction, out of order and with losses', () => {
    for (const [len, maxFrag] of cases) {
      const cbor = cborEncode(random(len, len + 7));
      const enc = new NUREncoder(new NUR(Buffer.from(cbor), 'bytes'), maxFrag, 0, 10);
      const parts = Array.from({ length: 200 }, () => enc.nextPart());
      // Drop every third part and reverse the order: mixed parts must fill the gaps.
      const dec = new URDecoder();
      for (const p of parts.filter((_, i) => i % 3 !== 1).reverse()) {
        dec.receive(p.toUpperCase());
        if (dec.result) break;
      }
      expect(dec.result?.type).toBe('bytes');
      expect(dec.result.cbor).toEqual(cbor);

      const ours = new UREncoder('bytes', cbor, maxFrag);
      const nd = new NURDecoder();
      for (let i = 0; i < 400 && !nd.isComplete(); i++) {
        const p = ours.nextPart();
        if (i % 4 !== 0) nd.receivePart(p);
      }
      expect(nd.isSuccess()).toBe(true);
      expect(new Uint8Array(nd.resultUR().cbor)).toEqual(cbor);
    }
  });

  it('rejects parts from a different message once started', () => {
    const a = new UREncoder('bytes', cborEncode(random(600, 1)), 100);
    const b = new UREncoder('bytes', cborEncode(random(600, 2)), 100);
    const dec = new URDecoder();
    expect(dec.receive(a.nextPart())).toBe(true);
    expect(dec.receive(b.nextPart())).toBe(false);
    expect(() => dec.receive('hello')).toThrow();
  });
});

describe('UR types', () => {
  it('round-trips PSBT bytes', () => {
    const psbt = random(300, 9);
    expect(cborToPsbt(psbtToCbor(psbt))).toEqual(psbt);
  });

  it('reproduces the crypto-account test vector of BCR-2020-015', () => {
    const net = getNetwork('btc');
    const root = rootFromMnemonic(vector.mnemonic, '', net);
    expect(root.fingerprint).toBe(0x37b5eed4);
    for (const type of ['pkh', 'sh-wpkh', 'wpkh', 'tr']) {
      const ours = hex.encode(accountToCbor(hdAccountFromRoot(root, net, type, accountPath(net, type, 0))));
      const prefix = 'a2011a37b5eed40281';
      expect(ours.startsWith(prefix)).toBe(true);
      expect(vector.cborHex).toContain(ours.slice(prefix.length));
    }
  });

  it('reads the spec UR and keeps the single-key accounts', () => {
    const dec = new URDecoder();
    dec.receive(vector.ur);
    expect(hex.encode(dec.result.cbor)).toBe(vector.cborHex);
    const accounts = accountsFromUR(dec.result.type, dec.result.cbor);
    expect(accounts.map((a) => a.type)).toEqual(['pkh', 'sh-wpkh', 'wpkh', 'tr']);
    expect(accounts.map((a) => a.node.publicExtendedKey)).toEqual([
      'xpub6CnQkivUEH9bSbWVWfDLCtigKKgnSWGaVSRyCbN2QNBJzuvHT1vUQpgSpY1NiVvoeNEuVwk748Cn9G3NtbQB1aGGsEL7aYEnjVWgjj9tefu',
      'xpub6CtR1iF4dZPkEyXDwVf3HE74tSwXNMcHtBzX4gwz2UnPhJ54Jz5unHx2syYCCDkvVUmsmoYTmcaHXe1wJppvct4GMMaN5XAbRk7yGScRSte',
      'xpub6BkU445MSEBXbPjD3g2c2ch6mn8yy1SXXQUM7EwjgYiq6Wt1NDwDZ45npqWcV8uQC5oi2gHuVukoCoZZyT4HKq8EpotPMqGqxdZRuapCQ23',
      'xpub6DAvL2L5bgGSpDygSQUDpjwE47saoMk2rSRtYhN7Dma7HvnFLTXNrcSC1AmEN8G2SCD958bUwgc6Bew4sAFa2kqYynF8Rmu6P5jMt2FDPtm',
    ]);
    expect(accounts.every((a) => a.fingerprint === 0x37b5eed4 && !a.testnet)).toBe(true);
  });
});
