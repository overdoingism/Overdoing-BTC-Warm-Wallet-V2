import { describe, expect, it } from 'vitest';
import * as L from '@bitauth/libauth';
import { hex } from '@scure/base';
import { getNetwork } from '../../src/core/networks.js';
import { accountPath, deriveAddress, hdAccountFromRoot, privateKeyFor, rootFromMnemonic } from '../../src/core/keys.js';
import { BCH_DUST, buildBchPsbt, describeBchPsbt, estimateSize, finalizeBchPsbt, selectCoins, signBchPsbt } from '../../src/core/bch.js';

const BCH = getNetwork('bch');
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = rootFromMnemonic(ABANDON, '', BCH);
const account = hdAccountFromRoot(root, BCH, 'pkh', accountPath(BCH, 'pkh', 0));

/** A fake funding transaction with outputs to the given scripts. */
function fundingTx(outputs, tag = 1) {
  const tx = {
    version: 2,
    inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(tag), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.of(0x51) }],
    outputs: outputs.map(([script, value]) => ({ lockingBytecode: script, valueSatoshis: value })),
    locktime: 0,
  };
  const raw = L.encodeTransactionBCH(tx);
  return { raw, txid: L.hashTransaction(raw) };
}

function signedTransfer({ fundings, recipient, amount, change }) {
  const inputs = fundings.map(({ f, vout, addr }) => ({ txid: f.txid, vout, prevTx: f.raw, pubkey: addr.pubkey, path: addr.path, fingerprint: account.fingerprint }));
  const outputs = [{ script: recipient, amount }];
  if (change) outputs.push({ script: change.addr.script, amount: change.amount, pubkey: change.addr.pubkey, path: change.addr.path, fingerprint: account.fingerprint });
  const psbt = buildBchPsbt({ inputs, outputs });
  const { psbt: signedPsbt, signed } = signBchPsbt(psbt, (inp) => {
    const d = inp.derivations[0];
    return d && d.fingerprint === account.fingerprint ? privateKeyFor(account, d.path) : undefined;
  });
  return { psbt, signedPsbt, signed, final: finalizeBchPsbt(signedPsbt) };
}

function verifyWithLibauth(rawHex, sourceOutputs) {
  const transaction = L.decodeTransactionBCH(hex.decode(rawHex));
  expect(typeof transaction).not.toBe('string');
  const vm = L.createVirtualMachineBCH();
  return vm.verify({ sourceOutputs: sourceOutputs.map(([lockingBytecode, valueSatoshis]) => ({ lockingBytecode, valueSatoshis })), transaction });
}

describe('Bitcoin Cash signing', () => {
  it('produces transactions that the libauth BCH virtual machine accepts', () => {
    const a0 = deriveAddress(account, 0, 0);
    const a1 = deriveAddress(account, 0, 1);
    const c0 = deriveAddress(account, 1, 0);
    const f1 = fundingTx([[a0.script, 50_000n], [a1.script, 70_000n]], 1);
    const f2 = fundingTx([[a1.script, 30_000n]], 2);
    const recipient = deriveAddress(account, 0, 9).script;
    const { final, signed } = signedTransfer({
      fundings: [{ f: f1, vout: 0, addr: a0 }, { f: f1, vout: 1, addr: a1 }, { f: f2, vout: 0, addr: a1 }],
      recipient,
      amount: 100_000n,
      change: { addr: c0, amount: 49_000n },
    });
    expect(signed).toBe(3);
    expect(verifyWithLibauth(final.hex, [[a0.script, 50_000n], [a1.script, 70_000n], [a1.script, 30_000n]])).toBe(true);
    expect(final.txid).toBe(L.hashTransaction(hex.decode(final.hex)));
  });

  it('is rejected by the VM when an input amount is misreported', () => {
    const a0 = deriveAddress(account, 0, 0);
    const f = fundingTx([[a0.script, 10_000n]], 3);
    const { final } = signedTransfer({ fundings: [{ f, vout: 0, addr: a0 }], recipient: a0.script, amount: 9_000n });
    expect(verifyWithLibauth(final.hex, [[a0.script, 10_000n]])).toBe(true);
    expect(verifyWithLibauth(final.hex, [[a0.script, 10_001n]])).not.toBe(true);
  });

  it('refuses a previous transaction that does not match the outpoint', () => {
    const a0 = deriveAddress(account, 0, 0);
    const f = fundingTx([[a0.script, 10_000n]], 4);
    const other = fundingTx([[a0.script, 99_000n]], 5);
    // Rejected while building, and also when parsing a PSBT that someone else built.
    expect(() => buildBchPsbt({ inputs: [{ txid: f.txid, vout: 0, prevTx: other.raw }], outputs: [{ script: a0.script, amount: 9_000n }] })).toThrowError('err.prevTxMismatch');
    const good = buildBchPsbt({ inputs: [{ txid: f.txid, vout: 0, prevTx: f.raw }], outputs: [{ script: a0.script, amount: 9_000n }] });
    const forged = hex.decode(hex.encode(good).replace(hex.encode(f.raw), hex.encode(other.raw)));
    expect(() => describeBchPsbt(forged)).toThrowError('err.prevTxMismatch');
  });

  it('selects coins largest-first, drops dust change and supports "max"', () => {
    const s = deriveAddress(account, 0, 0).script;
    const utxos = [10_000n, 50_000n, 2_000n].map((value, i) => ({ txid: String(i), vout: 0, value }));
    const pick = selectCoins(utxos, { amount: 30_000n, recipientScript: s, changeScript: s, feeRate: 1 });
    expect(pick.inputs.map((u) => u.value)).toEqual([50_000n]);
    expect(pick.fee).toBe(BigInt(estimateSize(1, [s, s])));
    expect(pick.change).toBe(50_000n - 30_000n - pick.fee);
    const max = selectCoins(utxos, { max: true, recipientScript: s, changeScript: s, feeRate: 1 });
    expect(max.inputs).toHaveLength(3);
    expect(max.amount + max.fee).toBe(62_000n);
    const tight = selectCoins(utxos, { amount: 50_000n - BigInt(estimateSize(1, [s])) - 100n, recipientScript: s, changeScript: s, feeRate: 1 });
    expect(tight.change).toBe(0n); // the 100 sat remainder is below dust and goes to fees
    expect(BCH_DUST).toBe(546n);
    expect(() => selectCoins(utxos, { amount: 70_000n, recipientScript: s, changeScript: s, feeRate: 1 })).toThrowError('err.insufficient');
  });
});
