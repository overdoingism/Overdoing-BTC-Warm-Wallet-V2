// Bitcoin Cash transactions: P2PKH spends signed with SIGHASH_ALL|FORKID (the BIP143-style
// replay-protected digest). Partially signed transactions travel in the standard PSBT v0
// container (BIP174 key types are chain-agnostic); only the signature algorithm differs.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { WalletError } from './errors.js';

export const SIGHASH_ALL_FORKID = 0x41;
export const BCH_SEQUENCE = 0xfffffffe;
export const BCH_DUST = 546n;
const dsha = (b) => sha256(sha256(b));

// ---------------------------------------------------------------- serialization helpers
function varint(n) {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 255, n >> 8];
  return [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
}
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
const u64le = (v) => {
  const out = [];
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 255n));
    x >>= 8n;
  }
  return out;
};
const txidLE = (txid) => [...hex.decode(txid)].reverse();
const outputBytes = (o) => [...u64le(o.amount), ...varint(o.script.length), ...o.script];

/** The SIGHASH_ALL|FORKID digest for input `idx` (spending a P2PKH output). */
export function sighashForkId({ version, lockTime, inputs, outputs }, idx, prevScript, prevAmount) {
  const prevouts = inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.index)]);
  const sequences = inputs.flatMap((i) => u32le(i.sequence));
  const outs = outputs.flatMap(outputBytes);
  const inp = inputs[idx];
  const preimage = Uint8Array.from([
    ...u32le(version),
    ...dsha(Uint8Array.from(prevouts)),
    ...dsha(Uint8Array.from(sequences)),
    ...txidLE(inp.txid),
    ...u32le(inp.index),
    ...varint(prevScript.length),
    ...prevScript,
    ...u64le(prevAmount),
    ...u32le(inp.sequence),
    ...dsha(Uint8Array.from(outs)),
    ...u32le(lockTime),
    ...u32le(SIGHASH_ALL_FORKID),
  ]);
  return dsha(preimage);
}

export function signForkId(privateKey, digest) {
  const der = secp256k1.sign(digest, privateKey, { prehash: false, format: 'der', lowS: true });
  return Uint8Array.from([...der, SIGHASH_ALL_FORKID]);
}

// ---------------------------------------------------------------- size & selection
// P2PKH: input 148 bytes (with a 72-byte signature), output 34 (+ script length differences).
export const estimateSize = (nIn, outputScripts) =>
  10 + nIn * 148 + outputScripts.reduce((s, script) => s + 8 + varint(script.length).length + script.length, 0);

/**
 * Picks inputs largest-first. Returns { inputs, change, fee, size } or throws err.insufficient.
 * `max` spends everything to the recipient. Token-carrying UTXOs must be filtered out before.
 */
export function selectCoins(utxos, { amount, max, recipientScript, changeScript, feeRate, all }) {
  const sorted = [...utxos].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
  const feeFor = (n, scripts) => BigInt(Math.ceil(estimateSize(n, scripts) * feeRate));
  if (max || all) {
    const total = sorted.reduce((s, u) => s + u.value, 0n);
    if (max) {
      const fee = feeFor(sorted.length, [recipientScript]);
      if (total - fee < BCH_DUST) throw new WalletError('err.insufficient');
      return { inputs: sorted, amount: total - fee, change: 0n, fee, size: estimateSize(sorted.length, [recipientScript]) };
    }
    const fee = feeFor(sorted.length, [recipientScript, changeScript]);
    const change = total - amount - fee;
    if (change < 0n) throw new WalletError('err.insufficient');
    if (change < BCH_DUST) return { inputs: sorted, amount, change: 0n, fee: total - amount, size: estimateSize(sorted.length, [recipientScript]) };
    return { inputs: sorted, amount, change, fee, size: estimateSize(sorted.length, [recipientScript, changeScript]) };
  }
  const chosen = [];
  let total = 0n;
  for (const u of sorted) {
    chosen.push(u);
    total += u.value;
    const feeWithChange = feeFor(chosen.length, [recipientScript, changeScript]);
    const feeNoChange = feeFor(chosen.length, [recipientScript]);
    if (total >= amount + feeWithChange + BCH_DUST) {
      return { inputs: chosen, amount, change: total - amount - feeWithChange, fee: feeWithChange, size: estimateSize(chosen.length, [recipientScript, changeScript]) };
    }
    if (total >= amount + feeNoChange) {
      return { inputs: chosen, amount, change: 0n, fee: total - amount, size: estimateSize(chosen.length, [recipientScript]) };
    }
  }
  throw new WalletError('err.insufficient');
}

// ---------------------------------------------------------------- PSBT container
const P2PKH_RE = /^76a914[0-9a-f]{40}88ac$/;

/** Turns @scure/btc-signer validation errors into wallet errors the UI can explain. */
export function scureError(e) {
  if (e instanceof WalletError) return e;
  const msg = String(e?.message ?? e);
  if (/wrong txid|different from nonWitnessUtxo/i.test(msg)) return new WalletError('err.prevTxMismatch', { n: '?' });
  return new WalletError('err.psbtInvalid', { detail: msg });
}
const guard = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw scureError(e);
  }
};

/** Unsigned BCH transfer as a PSBT (inputs carry the full previous transaction). */
export function buildBchPsbt(args) {
  return guard(() => buildBchPsbtRaw(args));
}

function buildBchPsbtRaw({ inputs, outputs, lockTime = 0 }) {
  const tx = new btc.Transaction({ version: 2, lockTime, allowUnknownOutputs: true });
  for (const i of inputs) {
    const f = { txid: i.txid, index: i.vout, sequence: BCH_SEQUENCE, nonWitnessUtxo: i.prevTx };
    if (i.pubkey && i.path) f.bip32Derivation = [[i.pubkey, { fingerprint: i.fingerprint >>> 0, path: i.path }]];
    tx.addInput(f);
  }
  for (const o of outputs) {
    const f = { script: o.script, amount: o.amount };
    if (o.pubkey && o.path) f.bip32Derivation = [[o.pubkey, { fingerprint: o.fingerprint >>> 0, path: o.path }]];
    tx.addOutput(f);
  }
  return tx.toPSBT(0);
}

const parsePsbt = (psbt) => guard(() => btc.Transaction.fromPSBT(psbt, { allowUnknownOutputs: true, allowUnknownInputs: true }));

/** Plain view of the transaction for signing and review; verifies every previous transaction. */
export function describeBchPsbt(psbt) {
  const tx = parsePsbt(psbt);
  const inputs = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const txid = hex.encode(inp.txid);
    if (!inp.nonWitnessUtxo) throw new WalletError('err.prevTxMissing', { n: i + 1 });
    const prevRaw = btc.RawTx.encode(inp.nonWitnessUtxo);
    if (hex.encode(dsha(prevRaw).reverse()) !== txid) throw new WalletError('err.prevTxMismatch', { n: i + 1 });
    const prevOut = inp.nonWitnessUtxo.outputs[inp.index];
    if (!prevOut) throw new WalletError('err.prevTxMismatch', { n: i + 1 });
    if (prevOut.script[0] === 0xef) throw new WalletError('err.tokenInput', { n: i + 1 });
    inputs.push({
      txid,
      index: inp.index,
      sequence: inp.sequence,
      amount: prevOut.amount,
      script: prevOut.script,
      p2pkh: P2PKH_RE.test(hex.encode(prevOut.script)),
      derivations: (inp.bip32Derivation ?? []).map(([pubkey, d]) => ({ pubkey, ...d })),
      signed: !!(inp.partialSig?.length || inp.finalScriptSig),
    });
  }
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    outputs.push({ script: o.script, amount: o.amount, derivations: (o.bip32Derivation ?? []).map(([pubkey, d]) => ({ pubkey, ...d })) });
  }
  return { version: tx.version, lockTime: tx.lockTime, inputs, outputs };
}

/**
 * Signs the inputs for which keyFor(input) returns a private key. Returns the PSBT with
 * partial signatures and the number of inputs signed.
 */
export function signBchPsbt(psbt, keyFor) {
  const tx = parsePsbt(psbt);
  const view = describeBchPsbt(psbt);
  let signed = 0;
  view.inputs.forEach((inp, idx) => {
    const key = keyFor(inp);
    if (!key) return;
    if (!inp.p2pkh) throw new WalletError('err.inputType', { n: idx + 1 });
    const pubkey = secp256k1.getPublicKey(key, true);
    const digest = sighashForkId(view, idx, inp.script, inp.amount);
    tx.updateInput(idx, { partialSig: [[pubkey, signForkId(key, digest)]] }, true);
    signed++;
  });
  return { psbt: tx.toPSBT(0), signed };
}

/** Builds the final scriptSigs (<sig> <pubkey>) and returns the raw transaction hex + txid. */
export function finalizeBchPsbt(psbt) {
  const tx = parsePsbt(psbt);
  const view = describeBchPsbt(psbt);
  const parts = [...u32le(view.version), ...varint(tx.inputsLength)];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const sig = inp.partialSig?.[0];
    if (!sig) throw new WalletError('err.notFullySigned');
    const [pubkey, signature] = sig;
    const scriptSig = [signature.length, ...signature, pubkey.length, ...pubkey];
    parts.push(...txidLE(view.inputs[i].txid), ...u32le(inp.index), ...varint(scriptSig.length), ...scriptSig, ...u32le(inp.sequence));
  }
  parts.push(...varint(view.outputs.length), ...view.outputs.flatMap(outputBytes), ...u32le(view.lockTime));
  const raw = Uint8Array.from(parts);
  const fee = view.inputs.reduce((t, i) => t + i.amount, 0n) - view.outputs.reduce((t, o) => t + o.amount, 0n);
  return { hex: hex.encode(raw), txid: hex.encode(dsha(raw).reverse()), size: raw.length, vsize: raw.length, fee };
}
