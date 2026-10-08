// Bitcoin transactions as PSBTs (BIP174): build on the watch-only side, review and sign on the
// signer, finalize and broadcast online. The signer never trusts amounts it cannot verify:
// every non-Taproot input must carry its full previous transaction, which is hashed and
// compared with the outpoint (Taproot signatures commit to all input amounts by themselves).
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { scureNet } from './networks.js';
import { scriptToAddress } from './address.js';
import { WalletError } from './errors.js';

export const RBF_SEQUENCE = 0xfffffffd;
export const NO_RBF_SEQUENCE = 0xfffffffe; // still allows nLockTime (anti fee sniping)
const dsha = (b) => sha256(sha256(b));
const xonly = (pub) => (pub.length === 33 ? pub.slice(1) : pub);

export function scureError(e) {
  if (e instanceof WalletError) return e;
  const msg = String(e?.message ?? e);
  if (/wrong txid|different from nonWitnessUtxo/i.test(msg)) return new WalletError('err.prevTxMismatch', { n: '?' });
  if (/not enough|insufficient/i.test(msg)) return new WalletError('err.insufficient');
  return new WalletError('err.psbtInvalid', { detail: msg });
}
const guard = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw scureError(e);
  }
};

const TX_OPTS = { allowUnknownOutputs: true, PSBTVersion: 0 };
export const parsePsbt = (psbt) => guard(() => btc.Transaction.fromPSBT(psbt, { allowUnknownOutputs: true }));

/** PSBT input for one of our UTXOs (see wallet.js for the utxo shape). */
export function inputFor(account, utxo, { requirePrev = true } = {}) {
  const f = { txid: utxo.txid, index: utxo.vout, sequence: utxo.sequence ?? RBF_SEQUENCE };
  if (utxo.type !== 'pkh') f.witnessUtxo = { script: utxo.script, amount: utxo.value };
  if (utxo.type !== 'tr') {
    if (utxo.prevTx) f.nonWitnessUtxo = utxo.prevTx;
    else if (requirePrev) throw new WalletError('err.prevTxMissing', { n: utxo.txid.slice(0, 8) });
  }
  if (utxo.redeemScript) f.redeemScript = utxo.redeemScript;
  if (utxo.type === 'tr') f.tapInternalKey = utxo.tapInternalKey;
  if (utxo.path && utxo.pubkey) {
    const der = { fingerprint: account.fingerprint >>> 0, path: utxo.path };
    if (utxo.type === 'tr') f.tapBip32Derivation = [[xonly(utxo.pubkey), { hashes: [], der }]];
    else f.bip32Derivation = [[utxo.pubkey, der]];
  }
  return f;
}

function outputDerivation(account, addr) {
  if (!addr.path || !addr.pubkey) return {};
  const der = { fingerprint: account.fingerprint >>> 0, path: addr.path };
  if (account.type === 'tr') return { tapInternalKey: xonly(addr.pubkey), tapBip32Derivation: [[xonly(addr.pubkey), { hashes: [], der }]] };
  const extra = addr.redeemScript ? { redeemScript: addr.redeemScript } : {};
  return { ...extra, bip32Derivation: [[addr.pubkey, der]] };
}

/**
 * Builds an unsigned transfer.
 * utxos: candidates (or exactly the coins to spend when `useAll`); to: { address, script };
 * amount: bigint sat (ignored when `max`); feeRate: sat/vB (decimals allowed);
 * change: one of our addresses (deriveAddress result).
 */
export function buildBtcPsbt({ account, utxos, to, amount, max, useAll, feeRate, change, lockTime = 0, selectionOnly = false }) {
  return guard(() => {
    const net = scureNet(account.net);
    // selectionOnly: SegWit coins can be chosen without their previous transactions.
    const inputs = utxos.map((u) => inputFor(account, u, { requirePrev: !selectionOnly }));
    const outputs = max ? [] : [{ script: to.script, amount }];
    // Selection works on whole sat/vB; the exact (fractional) fee is applied afterwards.
    const selected = btc.selectUTXO(inputs, outputs, max || useAll ? 'all' : 'default', {
      feePerByte: BigInt(Math.max(1, Math.ceil(feeRate))),
      changeAddress: max ? to.address : change.address,
      network: net,
      createTx: true,
      bip69: false,
      ...TX_OPTS,
      version: 2,
      lockTime,
    });
    if (!selected) throw new WalletError('err.insufficient');
    const tx = selected.tx;
    const vsize = Math.ceil(selected.weight / 4);
    const exactFee = BigInt(Math.ceil(vsize * feeRate));
    const changeScript = hex.encode(max ? to.script : change.script);
    let changeIdx = -1;
    for (let i = 0; i < tx.outputsLength; i++) if (hex.encode(tx.getOutput(i).script) === changeScript) changeIdx = i;
    if (changeIdx >= 0 && selected.change) {
      const out = tx.getOutput(changeIdx);
      tx.updateOutput(changeIdx, { amount: out.amount + selected.fee - exactFee });
      if (!max) tx.updateOutput(changeIdx, outputDerivation(account, change));
    }
    return { psbt: tx.toPSBT(0), fee: selected.change ? exactFee : selected.fee, vsize };
  });
}

// ---------------------------------------------------------------- review
export const txidOf = (rawTxObject) => hex.encode(dsha(btc.RawTx.encode({ ...rawTxObject, segwitFlag: false, witnesses: undefined })).reverse());

function inputKind(script) {
  try {
    return btc.OutScript.decode(script).type;
  } catch {
    return 'unknown';
  }
}

/** Typical vsize per input type, for fee-rate display before signing. */
const INPUT_VB = { pkh: 148, sh: 91, wpkh: 68, tr: 57.5 };

/**
 * Everything the signer (or the online side) needs to show before signing / broadcasting.
 * `isMine(script, derivations)` → { path } when the script belongs to the loaded account.
 */
export function reviewBtcPsbt(psbt, net, isMine) {
  const tx = parsePsbt(psbt);
  const inputs = [];
  let totalIn = 0n;
  let amountsKnown = true;
  let vbytes = 10.5;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const txid = hex.encode(inp.txid);
    let prevOut = inp.witnessUtxo;
    let verified = false;
    if (inp.nonWitnessUtxo) {
      if (txidOf(inp.nonWitnessUtxo) !== txid) throw new WalletError('err.prevTxMismatch', { n: i + 1 });
      const out = inp.nonWitnessUtxo.outputs[inp.index];
      if (!out) throw new WalletError('err.prevTxMismatch', { n: i + 1 });
      if (prevOut && (prevOut.amount !== out.amount || hex.encode(prevOut.script) !== hex.encode(out.script))) {
        throw new WalletError('err.prevTxMismatch', { n: i + 1 });
      }
      prevOut = out;
      verified = true;
    }
    if (!prevOut) {
      amountsKnown = false;
      inputs.push({ txid, index: inp.index, kind: 'unknown', verified: false });
      continue;
    }
    const kind = inputKind(prevOut.script);
    if (kind === 'tr') verified = true; // BIP341 sighash commits to every input amount
    const derivations = [
      ...(inp.bip32Derivation ?? []).map(([pubkey, d]) => ({ pubkey, ...d })),
      ...(inp.tapBip32Derivation ?? []).map(([pubkey, d]) => ({ pubkey, ...d.der })),
    ];
    const mine = isMine?.(prevOut.script, derivations) ?? null;
    totalIn += prevOut.amount;
    vbytes += INPUT_VB[kind] ?? 100;
    inputs.push({
      txid,
      index: inp.index,
      amount: prevOut.amount,
      script: prevOut.script,
      address: scriptToAddress(net, prevOut.script),
      kind,
      verified,
      mine,
      sequence: inp.sequence,
      signed: !!(inp.partialSig?.length || inp.tapKeySig || inp.finalScriptSig || inp.finalScriptWitness),
    });
  }
  const outputs = [];
  let totalOut = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const derivations = [
      ...(o.bip32Derivation ?? []).map(([pubkey, d]) => ({ pubkey, ...d })),
      ...(o.tapBip32Derivation ?? []).map(([pubkey, d]) => ({ pubkey, ...d.der })),
    ];
    const mine = derivations.length ? isMine?.(o.script, derivations) ?? null : null;
    totalOut += o.amount;
    vbytes += 9 + o.script.length;
    outputs.push({ script: o.script, amount: o.amount, address: scriptToAddress(net, o.script), change: !!mine, mine });
  }
  const fee = amountsKnown ? totalIn - totalOut : undefined;
  return {
    inputs,
    outputs,
    totalIn,
    totalOut,
    fee,
    vsize: Math.ceil(vbytes),
    rbf: inputs.some((i) => i.sequence !== undefined && i.sequence < NO_RBF_SEQUENCE),
    lockTime: tx.lockTime,
  };
}

// ---------------------------------------------------------------- sign / finalize
/**
 * Signs the inputs for which keyFor(reviewedInput) returns a private key.
 * Refuses inputs whose amount could not be verified.
 */
export function signBtcPsbt(psbt, review, keyFor) {
  return guard(() => {
    const tx = btc.Transaction.fromPSBT(psbt, { allowUnknownOutputs: true });
    let signed = 0;
    review.inputs.forEach((inp, idx) => {
      if (!inp.mine) return;
      if (!inp.verified) throw new WalletError('err.prevTxMissing', { n: idx + 1 });
      const key = keyFor(inp);
      if (!key) return;
      if (tx.signIdx(key, idx)) signed++;
    });
    return { psbt: tx.toPSBT(0), signed };
  });
}

/** Finalizes a fully signed PSBT → { hex, txid, vsize, fee }. */
export function finalizeBtcPsbt(psbt) {
  return guard(() => {
    const tx = btc.Transaction.fromPSBT(psbt, { allowUnknownOutputs: true });
    try {
      tx.finalize();
    } catch {
      throw new WalletError('err.notFullySigned');
    }
    return { hex: tx.hex, txid: tx.id, vsize: tx.vsize, fee: tx.fee };
  });
}

/** Signed raw transaction hex → summary for the broadcaster. */
export function describeRawTx(rawHex, net) {
  return guard(() => {
    const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    const outputs = [];
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      outputs.push({ script: o.script, amount: o.amount, address: scriptToAddress(net, o.script) });
    }
    return { txid: tx.id, vsize: tx.vsize, inputs: tx.inputsLength, outputs };
  });
}
