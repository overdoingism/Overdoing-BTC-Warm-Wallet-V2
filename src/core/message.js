// Signed messages.
//   BIP137 ("Bitcoin Signed Message"): P2PKH, P2SH-P2WPKH, P2WPKH, and Bitcoin Cash (Electron Cash
//   uses the same scheme). Verification also accepts Electrum-style headers (31–34 for any type).
//   BIP322 "simple": Taproot, which has no BIP137 form.
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { hash160, scriptFor } from './keys.js';
import { parseRecipient } from './address.js';
import { WalletError } from './errors.js';

const te = new TextEncoder();
const dsha = (b) => sha256(sha256(b));
function varint(n) {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 255, n >> 8];
  return [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
}

export function bip137Hash(message) {
  const magic = te.encode('Bitcoin Signed Message:\n');
  const msg = te.encode(message);
  return dsha(Uint8Array.from([magic.length, ...magic, ...varint(msg.length), ...msg]));
}

const HEADER_BASE = { pkh: 31, 'sh-wpkh': 35, wpkh: 39 };

function bip137Sign(privateKey, message, type) {
  const rec = secp256k1.sign(bip137Hash(message), privateKey, { prehash: false, format: 'recovered' });
  return base64.encode(Uint8Array.from([HEADER_BASE[type] + rec[0], ...rec.slice(1)]));
}

// ---------------------------------------------------------------- BIP322 simple (Taproot)
const tagged = (tag, data) => {
  const t = sha256(te.encode(tag));
  return sha256(Uint8Array.from([...t, ...t, ...data]));
};

const bip322MessageHash = (message) => tagged('BIP0322-signed-message', te.encode(message));

function bip322Txs(script, message) {
  const msgHash = bip322MessageHash(message);
  const toSpend = btc.RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: Uint8Array.from([0x00, 0x20, ...msgHash]), sequence: 0 }],
    outputs: [{ amount: 0n, script }],
    lockTime: 0,
  });
  const toSpendId = dsha(toSpend).reverse();
  const toSign = new btc.Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  toSign.addInput({ txid: toSpendId, index: 0, sequence: 0, witnessUtxo: { script, amount: 0n } });
  toSign.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
  return toSign;
}

/** For tests: the message hash and the txids of to_spend / to_sign (BIP322 test vectors). */
export function bip322Hashes(script, message) {
  const tx = bip322Txs(script, message);
  return { messageHash: hex.encode(bip322MessageHash(message)), toSpendTxid: hex.encode(tx.getInput(0).txid), toSignTxid: tx.id };
}

function bip322SignTaproot(privateKey, message, net) {
  const pub = secp256k1.getPublicKey(privateKey, true);
  const { script, tapInternalKey } = scriptFor(net, 'tr', pub);
  const tx = bip322Txs(script, message);
  tx.updateInput(0, { tapInternalKey });
  tx.signIdx(privateKey, 0);
  tx.finalizeIdx(0);
  const witness = tx.getInput(0).finalScriptWitness;
  return base64.encode(Uint8Array.from([...varint(witness.length), ...witness.flatMap((w) => [...varint(w.length), ...w])]));
}

function bip322VerifyTaproot(script, message, signature) {
  // Newer BIP322 revisions prefix simple signatures with "smp"; unprefixed ones stay valid.
  const s = String(signature).trim();
  if (/^[a-z]{3}/.test(s) && !s.startsWith('smp')) return false;
  const raw = base64.decode(s.startsWith('smp') ? s.slice(3) : s);
  if (raw[0] !== 1 || (raw[1] !== 64 && raw[1] !== 65)) return false;
  const sig = raw.slice(2, 2 + raw[1]);
  if (sig.length === 65 && sig[64] !== 0x01) return false;
  const tx = bip322Txs(script, message);
  const digest = tx.preimageWitnessV1(0, [script], sig.length === 65 ? 0x01 : 0x00, [0n]);
  return schnorr.verify(sig.slice(0, 64), digest, script.slice(2));
}

// ---------------------------------------------------------------- public API
/** Signs `message` with the key of an address of type `type`; returns the base64 signature. */
export function signMessage(privateKey, message, type, net) {
  if (!message) throw new WalletError('err.messageEmpty');
  if (type === 'tr') return bip322SignTaproot(privateKey, message, net);
  return bip137Sign(privateKey, message, type);
}

/** true when `signature` (base64) is a valid signature of `message` by `address`. */
export function verifyMessage(net, address, message, signature) {
  let target;
  try {
    target = parseRecipient(net, address);
  } catch {
    return false;
  }
  if (target.kind === 'tr') {
    try {
      return bip322VerifyTaproot(target.script, message, signature);
    } catch {
      return false;
    }
  }
  let raw;
  try {
    raw = base64.decode(String(signature).trim());
  } catch {
    return false;
  }
  if (raw.length !== 65 || raw[0] < 27 || raw[0] > 42) return false;
  const recovery = (raw[0] - 27) & 3;
  let pub;
  try {
    pub = secp256k1.recoverPublicKey(Uint8Array.from([recovery, ...raw.slice(1)]), bip137Hash(message), { prehash: false });
  } catch {
    return false;
  }
  const compressed = raw[0] >= 31;
  const key = compressed ? pub : secp256k1.Point.fromBytes(pub).toBytes(false);
  // Accept whichever single-key script type the address actually is (Electrum uses 31–34 for all).
  const want = hex.encode(target.script);
  const candidates = [hex.encode(Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(key), 0x88, 0xac]))];
  if (compressed && net.coin === 'btc') {
    candidates.push(hex.encode(scriptFor(net, 'wpkh', pub).script), hex.encode(scriptFor(net, 'sh-wpkh', pub).script));
  }
  return candidates.includes(want);
}
