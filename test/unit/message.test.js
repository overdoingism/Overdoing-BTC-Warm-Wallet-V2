import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getNetwork } from '../../src/core/networks.js';
import { accountPath, deriveAddress, hdAccountFromRoot, parseWif, privateKeyFor, rootFromMnemonic } from '../../src/core/keys.js';
import { parseRecipient } from '../../src/core/address.js';
import { bip322Hashes, signMessage, verifyMessage } from '../../src/core/message.js';
import { createVault, decryptSecret, encryptSecret } from '../../src/core/vault.js';
import { classify, encodeMessageRequest, formatSignedMessage } from '../../src/core/payload.js';

const BTC = getNetwork('btc');
const BCH = getNetwork('bch');
const vectors = JSON.parse(readFileSync(new URL('../fixtures/bip322-basic-test-vectors.json', import.meta.url), 'utf8'));
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('BIP322 (Taproot) and BIP137 signed messages', () => {
  it('reproduces the BIP322 message and transaction hashes', () => {
    for (const v of vectors.tx_hashes) {
      const h = bip322Hashes(parseRecipient(BTC, v.address).script, v.message);
      expect(h).toEqual({ messageHash: v.message_hash, toSpendTxid: v.to_spend_tx_hash, toSignTxid: v.to_sign_tx_hash });
    }
  });

  it('verifies the BIP322 Taproot vector and signs verifiable messages with its key', () => {
    const v = vectors.simple.find((x) => x.type === 'p2tr');
    expect(verifyMessage(BTC, v.address, v.message, v.bip322_signatures[0])).toBe(true);
    expect(verifyMessage(BTC, v.address, v.message + '!', v.bip322_signatures[0])).toBe(false);
    expect(verifyMessage(BTC, v.address, v.message, 'smp' + v.bip322_signatures[0])).toBe(true);
    expect(verifyMessage(BTC, v.address, v.message, 'ful' + v.bip322_signatures[0])).toBe(false);
    const key = parseWif(v.private_keys[0]).privateKey;
    const sig = signMessage(key, '我擁有這個地址', 'tr', BTC);
    expect(verifyMessage(BTC, v.address, '我擁有這個地址', sig)).toBe(true);
  });

  it('signs and verifies BIP137 for every other address type, on BTC and BCH', () => {
    for (const [net, type] of [[BTC, 'pkh'], [BTC, 'sh-wpkh'], [BTC, 'wpkh'], [BCH, 'pkh']]) {
      const acc = hdAccountFromRoot(rootFromMnemonic(ABANDON, '', net), net, type, accountPath(net, type, 0));
      const a = deriveAddress(acc, 0, 3);
      const sig = signMessage(privateKeyFor(acc, a.path), 'hello 你好', type, net);
      expect(verifyMessage(net, a.address, 'hello 你好', sig), `${net.id} ${type}`).toBe(true);
      expect(verifyMessage(net, a.address, 'hello', sig)).toBe(false);
      expect(verifyMessage(net, deriveAddress(acc, 0, 4).address, 'hello 你好', sig)).toBe(false);
    }
  });

  it('accepts Electrum-style headers and rejects garbage', () => {
    const acc = hdAccountFromRoot(rootFromMnemonic(ABANDON, '', BTC), BTC, 'wpkh', accountPath(BTC, 'wpkh', 0));
    const a = deriveAddress(acc, 0, 0);
    const sig = Uint8Array.from(atob(signMessage(privateKeyFor(acc, a.path), 'x', 'wpkh', BTC)), (c) => c.charCodeAt(0));
    sig[0] = sig[0] - 39 + 31; // re-label as a P2PKH-style header, as Electrum does
    expect(verifyMessage(BTC, a.address, 'x', btoa(String.fromCharCode(...sig)))).toBe(true);
    expect(verifyMessage(BTC, a.address, 'x', 'not base64!!!')).toBe(false);
    expect(verifyMessage(BTC, 'not an address', 'x', 'AAAA')).toBe(false);
  });
});

describe('encrypted mnemonic vault', () => {
  const memory = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), dump: () => [...m.values()].join('') };
  };

  it('encrypts with scrypt + AES-GCM and detects a wrong password', async () => {
    const blob = await encryptSecret({ mnemonic: ABANDON }, 'ｐａｓｓ word', { n: 1 << 10 });
    expect(await decryptSecret(blob, 'pass word')).toEqual({ mnemonic: ABANDON }); // NFKC: full-width = half-width
    await expect(decryptSecret(blob, 'wrong')).rejects.toThrowError('err.vaultPassword');
    await expect(decryptSecret({ ...blob, n: 1 << 30 }, 'x')).rejects.toThrowError('err.vaultFormat');
  });

  it('stores only encrypted data and names', async () => {
    const storage = memory();
    const vault = createVault(storage);
    const e = await vault.add('Cold', { mnemonic: ABANDON, xpub: 'zpub…' }, 'correct horse', { n: 1 << 10 });
    expect(vault.list()).toEqual([{ id: e.id, name: 'Cold', created: e.created }]);
    expect(storage.dump()).not.toContain('abandon');
    expect(storage.dump()).not.toContain('zpub');
    expect(await vault.unlock(e.id, 'correct horse')).toMatchObject({ mnemonic: ABANDON });
    vault.remove(e.id);
    expect(vault.list()).toEqual([]);
  });
});

describe('scanned / pasted content', () => {
  it('recognizes payment URIs, addresses, accounts, PSBTs, transactions and messages', () => {
    expect(classify('bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=0.015&label=Shop', BTC)).toEqual({
      kind: 'payment',
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      amount: '0.015',
      label: 'Shop',
    });
    expect(classify('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a?amount=1', BCH)).toMatchObject({ kind: 'payment', amount: '1' });
    expect(() => classify('bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', BCH)).toThrowError('err.addressNetwork');
    expect(classify('BC1QCR8TE4KR609GCAWUTMRZA0J4XV80JY8Z306FYU', BTC)).toMatchObject({ kind: 'payment' });
    expect(classify('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs', BTC)).toMatchObject({ kind: 'account', parsed: { type: 'wpkh' } });
    expect(classify('UR:CRYPTO-PSBT/1-3/LPADAXCFAXHL', BTC)).toEqual({ kind: 'ur' });
    expect(classify('cHNidP8BAHECAAAAAQ==', BTC).kind).toBe('psbt');
    expect(classify('02000000' + '00'.repeat(80), BTC).kind).toBe('rawtx');
    expect(classify('70736274ff' + '00'.repeat(80), BTC).kind).toBe('psbt');
    expect(classify(encodeMessageRequest({ address: 'bc1q…', message: 'hi' }), BTC)).toEqual({ kind: 'msgRequest', address: 'bc1q…', message: 'hi' });
    const armored = formatSignedMessage({ address: 'bc1qx', message: 'line 1\nline 2', signature: 'SIG' });
    expect(classify(armored, BTC)).toEqual({ kind: 'signature', address: 'bc1qx', message: 'line 1\nline 2', signature: 'SIG' });
    expect(classify('hello', BTC)).toEqual({ kind: 'unknown' });
  });
});
