import { describe, expect, it } from 'vitest';
import * as L from '@bitauth/libauth';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { hex } from '@scure/base';
import { getNetwork } from '../../src/core/networks.js';
import {
  accountPath,
  deriveAddress,
  descriptorChecksum,
  displayXpub,
  formatDescriptor,
  hdAccountFromRoot,
  inspectMnemonic,
  parseDescriptor,
  parsePath,
  parseWif,
  parseXpub,
  rootFromMnemonic,
  singleAccountFromWif,
} from '../../src/core/keys.js';
import { decodeCashAddr, encodeCashAddr } from '../../src/core/cashaddr.js';
import { parseRecipient, scriptToAddress } from '../../src/core/address.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BTC = getNetwork('btc');
const BCH = getNetwork('bch');
const TBTC = getNetwork('btc-testnet4');
const account = (net, type, phrase = ABANDON, pass = '') => {
  const root = rootFromMnemonic(phrase, pass, net);
  return hdAccountFromRoot(root, net, type, accountPath(net, type, 0));
};

describe('HD accounts (BIP44/49/84/86 test vectors)', () => {
  it('derives the BIP84 vectors', () => {
    const acc = account(BTC, 'wpkh');
    expect(displayXpub(acc)).toBe('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs');
    expect(deriveAddress(acc, 0, 0).address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(deriveAddress(acc, 0, 1).address).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
    expect(deriveAddress(acc, 1, 0).address).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  });

  it('derives the BIP86, BIP49 and BIP44 vectors', () => {
    const tr = account(BTC, 'tr');
    expect(acc0(tr)).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
    expect(tr.node.publicExtendedKey).toBe('xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ');
    expect(acc0(account(BTC, 'sh-wpkh'))).toBe('37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
    expect(displayXpub(account(BTC, 'sh-wpkh'))).toBe('ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP');
    expect(acc0(account(BTC, 'pkh'))).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  });

  it('matches libauth for Bitcoin Cash (m/44\'/145\'/0\')', () => {
    const node = L.deriveHdPrivateNodeFromBip39Mnemonic(ABANDON);
    for (const [chain, index] of [[0, 0], [0, 5], [1, 0]]) {
      const pub = L.deriveHdPublicNode(L.deriveHdPath(node, `m/44'/145'/0'/${chain}/${index}`)).publicKey;
      const expected = L.publicKeyToP2pkhCashAddress({ publicKey: pub }).address;
      expect(deriveAddress(account(BCH, 'pkh'), chain, index).address).toBe(expected);
    }
    expect(acc0(account(BCH, 'pkh'))).toBe('bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6');
  });

  it('uses testnet prefixes and coin type 1 on test networks', () => {
    const acc = account(TBTC, 'wpkh');
    expect(acc.path).toEqual(parsePath("m/84'/1'/0'"));
    expect(acc0(acc)).toMatch(/^tb1q/);
    expect(displayXpub(acc)).toMatch(/^vpub/);
  });

  it('handles passphrases and Chinese mnemonics', () => {
    expect(acc0(account(BTC, 'wpkh', ABANDON, 'TREZOR'))).not.toBe(acc0(account(BTC, 'wpkh')));
    expect(inspectMnemonic(ABANDON.replace('about', 'abuot'))).toMatchObject({ status: 'unknownWords', unknownWords: ['abuot'] });
  });
});

const acc0 = (acc) => deriveAddress(acc, 0, 0).address;

describe('extended keys and descriptors', () => {
  it('parses SLIP-132 keys and keeps the implied type', () => {
    const z = parseXpub('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs');
    expect(z).toMatchObject({ testnet: false, impliedType: 'wpkh' });
    expect(parseXpub('not an xpub')).toBeNull();
  });

  it('computes BIP380 checksums', () => {
    expect(descriptorChecksum('raw(deadbeef)')).toBe('89f8spxm');
    expect(descriptorChecksum("pkh([d34db33f/44'/0'/0']xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/1/*)")).toBe('ml40v0wf');
  });

  it('round-trips descriptors for every script type', () => {
    for (const type of ['pkh', 'sh-wpkh', 'wpkh', 'tr']) {
      const acc = account(BTC, type);
      const text = formatDescriptor(acc);
      const parsed = parseDescriptor(text);
      expect(parsed).toMatchObject({ type, fingerprint: acc.fingerprint, path: acc.path, testnet: false });
      expect(parsed.node.publicExtendedKey).toBe(acc.node.publicExtendedKey);
    }
    expect(() => parseDescriptor(formatDescriptor(account(BTC, 'wpkh')).replace(/#.*/, '#qqqqqqqq'))).toThrowError('err.descChecksum');
  });
});

describe('WIF keys', () => {
  it('accepts compressed keys and rejects uncompressed ones clearly', () => {
    // Private key 1 (compressed) is the generator point: a well-known address.
    const one = parseWif('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn');
    expect(one.testnet).toBe(false);
    expect(singleAccountFromWif(one.privateKey, BTC, 'pkh').address).toBe('1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
    // Cross-check every type against bitcoinjs-lib.
    const k = parseWif('KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617');
    const pubkey = Buffer.from(ecc.pointFromScalar(k.privateKey, true));
    expect(singleAccountFromWif(k.privateKey, BTC, 'pkh').address).toBe(bitcoinjs.payments.p2pkh({ pubkey }).address);
    expect(singleAccountFromWif(k.privateKey, BTC, 'wpkh').address).toBe(bitcoinjs.payments.p2wpkh({ pubkey }).address);
    expect(singleAccountFromWif(k.privateKey, BTC, 'sh-wpkh').address).toBe(bitcoinjs.payments.p2sh({ redeem: bitcoinjs.payments.p2wpkh({ pubkey }) }).address);
    expect(() => parseWif('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ')).toThrowError('err.uncompressedWif');
    expect(parseWif('hello')).toBeNull();
  });
});

describe('CashAddr', () => {
  const VECTORS = [
    ['bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 0, '76a04053bda0a88bda5177b86a15c3b29f559873'],
    ['bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq', 1, '76a04053bda0a88bda5177b86a15c3b29f559873'],
  ];
  it('matches the spec vectors and libauth', () => {
    for (const [addr, type, h] of VECTORS) {
      expect(encodeCashAddr('bitcoincash', type, hex.decode(h))).toBe(addr);
      expect(decodeCashAddr(addr)).toMatchObject({ prefix: 'bitcoincash', type });
      expect(decodeCashAddr(addr.toUpperCase())).not.toBeNull();
      expect(decodeCashAddr(addr.split(':')[1], 'bitcoincash')).not.toBeNull();
    }
    for (let i = 0; i < 20; i++) {
      const payload = crypto.getRandomValues(new Uint8Array(i % 2 ? 32 : 20));
      const type = i % 4;
      const ours = encodeCashAddr('bchtest', type, payload);
      const theirs = L.encodeCashAddress({ prefix: 'bchtest', type: ['p2pkh', 'p2sh', 'p2pkhWithTokens', 'p2shWithTokens'][type], payload }).address;
      expect(ours).toBe(theirs);
    }
  });
  it('rejects corrupted addresses', () => {
    expect(decodeCashAddr('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b')).toBeNull();
    expect(decodeCashAddr('bitcoincash:Qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')).toBeNull();
  });
});

describe('recipients', () => {
  it('parses Bitcoin addresses of every kind and rejects other networks', () => {
    expect(parseRecipient(BTC, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu').kind).toBe('wpkh');
    expect(parseRecipient(BTC, 'BC1QCR8TE4KR609GCAWUTMRZA0J4XV80JY8Z306FYU').address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(parseRecipient(BTC, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr').kind).toBe('tr');
    expect(parseRecipient(BTC, '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf').kind).toBe('sh');
    expect(parseRecipient(BTC, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA').kind).toBe('pkh');
    expect(() => parseRecipient(BTC, 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toThrowError('err.address');
    expect(() => parseRecipient(TBTC, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toThrowError('err.addressNetwork');
    expect(() => parseRecipient(BTC, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv')).toThrowError();
  });

  it('parses Bitcoin Cash addresses, converting legacy ones', () => {
    const r = parseRecipient(BCH, 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
    expect(r).toMatchObject({ address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', kind: 'pkh' });
    expect(hex.encode(r.script)).toBe('76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac');
    expect(parseRecipient(BCH, '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu')).toMatchObject({ address: r.address, converted: true });
    expect(() => parseRecipient(BCH, 'bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')).toThrowError();
    expect(scriptToAddress(BCH, r.script)).toBe(r.address);
    expect(scriptToAddress(BTC, parseRecipient(BTC, '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf').script)).toBe('37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
  });
});
