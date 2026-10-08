import { describe, expect, it } from 'vitest';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { getNetwork } from '../../src/core/networks.js';
import { accountPath, deriveAddress, hdAccountFromRoot, rootFromMnemonic, singleAccountFromWif } from '../../src/core/keys.js';
import { parseRecipient } from '../../src/core/address.js';
import { buildBtcPsbt, finalizeBtcPsbt, reviewBtcPsbt, signBtcPsbt, txidOf } from '../../src/core/btc.js';
import { makeIsMine, makeKeyFor } from '../../src/core/ownership.js';

bitcoinjs.initEccLib(ecc);
const NET = getNetwork('btc-regtest');
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = rootFromMnemonic(ABANDON, '', NET);
const accountOf = (type) => hdAccountFromRoot(root, NET, type, accountPath(NET, type, 0));

let fundSeq = 0;
/** Raw funding transaction paying `value` to `script`; returns a wallet utxo record. */
function fund(account, addr, value) {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32).fill(++fundSeq), index: 0, finalScriptSig: Uint8Array.of(0x51), sequence: 0xffffffff }],
    outputs: [{ amount: value, script: addr.script }],
    lockTime: 0,
  });
  const txid = txidOf(btc.RawTx.decode(raw));
  return { txid, vout: 0, value, type: account.type, ...addr, prevTx: raw };
}

const recipient = parseRecipient(NET, 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');

function verifyWithBitcoinjs(psbtBytes) {
  const p = bitcoinjs.Psbt.fromBuffer(Buffer.from(psbtBytes), { network: bitcoinjs.networks.regtest });
  const validator = (pubkey, msghash, signature) =>
    pubkey.length === 32 ? ecc.verifySchnorr(msghash, pubkey, signature) : ecc.verify(msghash, pubkey, signature);
  return p.validateSignaturesOfAllInputs(validator);
}

function flow(account, utxos, opts) {
  const change = deriveAddress(account, 1, 0);
  const built = buildBtcPsbt({ account, utxos, to: recipient, change, feeRate: 2, lockTime: 100, ...opts });
  const isMine = makeIsMine(account);
  const review = reviewBtcPsbt(built.psbt, NET, isMine);
  const signed = signBtcPsbt(built.psbt, review, makeKeyFor(account));
  return { built, review, signed, final: finalizeBtcPsbt(signed.psbt) };
}

describe('Bitcoin PSBT flow', () => {
  for (const type of ['wpkh', 'tr', 'sh-wpkh', 'pkh']) {
    it(`builds, reviews, signs and finalizes ${type} spends (signatures checked by bitcoinjs-lib)`, () => {
      const account = accountOf(type);
      const utxos = [fund(account, deriveAddress(account, 0, 0), 60_000n), fund(account, deriveAddress(account, 0, 3), 25_000n)];
      const { review, signed, final } = flow(account, utxos, { amount: 70_000n });
      expect(review.inputs.every((i) => i.verified && i.mine)).toBe(true);
      expect(review.outputs.filter((o) => o.change)).toHaveLength(1);
      expect(review.outputs.find((o) => !o.change)).toMatchObject({ amount: 70_000n, address: recipient.address });
      expect(signed.signed).toBe(2);
      expect(verifyWithBitcoinjs(signed.psbt)).toBe(true);
      // Fee matches the requested rate on the real (signed) size, within rounding of signatures.
      expect(Number(final.fee)).toBeGreaterThanOrEqual(final.vsize * 2 - 2);
      expect(Number(final.fee)).toBeLessThanOrEqual(final.vsize * 2 + 4);
      expect(review.rbf).toBe(true);
    });
  }

  it('supports fractional fee rates and "max" without change', () => {
    const account = accountOf('wpkh');
    const utxos = [fund(account, deriveAddress(account, 0, 1), 10_000n), fund(account, deriveAddress(account, 0, 2), 5_000n)];
    const half = flow(account, utxos, { amount: 4_000n, feeRate: 0.5 });
    expect(Number(half.final.fee)).toBeLessThanOrEqual(Math.ceil(half.final.vsize * 0.5) + 2);
    const max = flow(account, utxos, { max: true });
    expect(max.review.outputs).toHaveLength(1);
    expect(max.review.outputs[0].amount + max.final.fee).toBe(15_000n);
  });

  it('spends exactly the chosen coins (coin control)', () => {
    const account = accountOf('wpkh');
    const big = fund(account, deriveAddress(account, 0, 4), 900_000n);
    const small = [fund(account, deriveAddress(account, 0, 5), 30_000n), fund(account, deriveAddress(account, 0, 6), 30_000n)];
    const { review } = flow(account, small, { amount: 40_000n, useAll: true });
    expect(review.inputs.map((i) => i.txid).sort()).toEqual(small.map((u) => u.txid).sort());
    expect(review.inputs.map((i) => i.txid)).not.toContain(big.txid);
  });

  it('signs for a single WIF key and for a mnemonic when the PSBT has no derivation info', () => {
    const wifAccount = singleAccountFromWif(hex.decode('0101010101010101010101010101010101010101010101010101010101010101'), NET, 'wpkh');
    const u = fund(wifAccount, wifAccount, 50_000n);
    const { signed } = flow(wifAccount, [u], { amount: 20_000n, change: wifAccount });
    expect(signed.signed).toBe(1);
    expect(verifyWithBitcoinjs(signed.psbt)).toBe(true);

    const hd = accountOf('wpkh');
    const addr = deriveAddress(hd, 0, 7);
    const bare = { ...fund(hd, addr, 40_000n), path: undefined, pubkey: undefined }; // built by a single-address watcher
    const built = buildBtcPsbt({ account: hd, utxos: [bare], to: recipient, amount: 10_000n, change: addr, feeRate: 1 });
    const review = reviewBtcPsbt(built.psbt, NET, makeIsMine(hd));
    expect(review.inputs[0].mine).toMatchObject({ chain: 0, index: 7 });
    expect(signBtcPsbt(built.psbt, review, makeKeyFor(hd)).signed).toBe(1);
  });
});

describe('Bitcoin PSBT safety checks', () => {
  const account = accountOf('wpkh');
  const isMine = makeIsMine(account);

  it('rejects a previous transaction that does not match the outpoint', () => {
    const u = fund(account, deriveAddress(account, 0, 0), 50_000n);
    const other = fund(account, deriveAddress(account, 0, 0), 99_000n);
    const good = buildBtcPsbt({ account, utxos: [u], to: recipient, amount: 10_000n, change: deriveAddress(account, 1, 0), feeRate: 1 }).psbt;
    const forged = hex.decode(hex.encode(good).replace(hex.encode(u.prevTx), hex.encode(other.prevTx)));
    expect(() => reviewBtcPsbt(forged, NET, isMine)).toThrowError('err.prevTxMismatch');
  });

  it('refuses to sign a SegWit input whose amount cannot be verified', () => {
    const addr = deriveAddress(account, 0, 0);
    const tx = new btc.Transaction();
    tx.addInput({
      txid: new Uint8Array(32).fill(0x77),
      index: 0,
      witnessUtxo: { script: addr.script, amount: 1_000n }, // claims a tiny amount, no full prev tx
      bip32Derivation: [[addr.pubkey, { fingerprint: account.fingerprint, path: addr.path }]],
    });
    tx.addOutput({ script: recipient.script, amount: 500n });
    const psbt = tx.toPSBT(0);
    const review = reviewBtcPsbt(psbt, NET, isMine);
    expect(review.inputs[0]).toMatchObject({ verified: false });
    expect(() => signBtcPsbt(psbt, review, makeKeyFor(account))).toThrowError('err.prevTxMissing');
  });

  it('does not treat an output as change just because it claims our derivation path', () => {
    const u = fund(account, deriveAddress(account, 0, 0), 50_000n);
    const built = buildBtcPsbt({ account, utxos: [u], to: recipient, amount: 10_000n, change: deriveAddress(account, 1, 0), feeRate: 1 });
    const tx = btc.Transaction.fromPSBT(built.psbt);
    const attacker = parseRecipient(NET, 'bcrt1q6rz28mcfaxtmd6v789l9rrlrusdprr9pz3cppk');
    // Swap the change script for an attacker's while keeping our derivation metadata.
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      if (o.bip32Derivation?.length) tx.updateOutput(i, { script: attacker.script });
    }
    const review = reviewBtcPsbt(tx.toPSBT(0), NET, isMine);
    expect(review.outputs.some((o) => o.change)).toBe(false);
  });
});
