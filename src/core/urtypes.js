// UR registry types (BCR-2020-006/007/010/015): PSBTs and account (xpub) exports.
// We write the widely supported "version 1" types (crypto-psbt, crypto-account) and read both
// version 1 and version 2 (psbt, hdkey) names.
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { Tagged, cborDecode, cborEncode } from './cbor.js';
import { SCRIPT_TYPES } from './networks.js';
import { WalletError } from './errors.js';

const base58check = createBase58check(sha256);
const HARDENED = 0x80000000;
const T = { hdkey: 303, keypath: 304, coininfo: 305, output: 308, sh: 400, wsh: 401, pkh: 403, wpkh: 404, tr: 409 };
// Version 2 tags are the version 1 tags + 40000.
const is = (tagged, name) => tagged instanceof Tagged && (tagged.tag === T[name] || tagged.tag === T[name] + 40000);

// ---------------------------------------------------------------- PSBT
export const PSBT_TYPES = ['crypto-psbt', 'psbt'];
export const BCH_PSBT_TYPE = 'bch-psbt';

export const psbtToCbor = (psbt) => cborEncode(psbt);

export function cborToPsbt(cbor) {
  let v = cborDecode(cbor);
  if (v instanceof Tagged) v = v.value;
  if (!(v instanceof Uint8Array)) throw new WalletError('err.urContent');
  return v;
}

// ---------------------------------------------------------------- account export
function hdkeyCbor(account) {
  const node = account.node;
  const net = account.net;
  const m = new Map();
  m.set(3, node.publicKey);
  m.set(4, node.chainCode);
  if (net.coin === 'bch' || net.testnet) {
    const info = new Map();
    if (net.coin === 'bch') info.set(1, 145);
    if (net.testnet) info.set(2, 1);
    m.set(5, new Tagged(T.coininfo, info));
  }
  const comps = account.path.flatMap((i) => (i >= HARDENED ? [i - HARDENED, true] : [i, false]));
  const origin = new Map([[1, comps]]);
  if (account.fingerprint) origin.set(2, account.fingerprint >>> 0);
  m.set(6, new Tagged(T.keypath, origin));
  if (node.parentFingerprint) m.set(8, node.parentFingerprint >>> 0);
  return new Tagged(T.hdkey, m);
}

function scriptExp(type, key) {
  if (type === 'pkh') return new Tagged(T.pkh, key);
  if (type === 'wpkh') return new Tagged(T.wpkh, key);
  if (type === 'sh-wpkh') return new Tagged(T.sh, new Tagged(T.wpkh, key));
  if (type === 'tr') return new Tagged(T.tr, key);
  throw new WalletError('err.scriptType');
}

/** crypto-account for one HD account (master fingerprint + one output descriptor). */
export function accountToCbor(account) {
  return cborEncode(new Map([[1, account.fingerprint >>> 0], [2, [new Tagged(T.output, scriptExp(account.type, hdkeyCbor(account)))]]]));
}

// ---------------------------------------------------------------- account import
function hdkeyFromCbor(tagged) {
  if (!is(tagged, 'hdkey')) throw new WalletError('err.urContent');
  const m = tagged.value;
  if (!(m instanceof Map) || m.get(1) === true || m.get(2) === true) throw new WalletError('err.urPrivate');
  const key = m.get(3);
  const chainCode = m.get(4);
  if (!(key instanceof Uint8Array) || key.length !== 33 || !(chainCode instanceof Uint8Array) || chainCode.length !== 32) {
    throw new WalletError('err.urContent');
  }
  const useInfo = m.get(5);
  const testnet = useInfo instanceof Tagged && useInfo.value instanceof Map && useInfo.value.get(2) === 1;
  const coinType = useInfo instanceof Tagged && useInfo.value instanceof Map ? useInfo.value.get(1) ?? 0 : 0;
  let path = [];
  let fingerprint = 0;
  const origin = m.get(6);
  if (origin) {
    if (!is(origin, 'keypath')) throw new WalletError('err.urContent');
    const comps = origin.value.get(1) ?? [];
    for (let i = 0; i + 1 < comps.length; i += 2) {
      if (typeof comps[i] !== 'number') throw new WalletError('err.urContent');
      path.push(comps[i] + (comps[i + 1] ? HARDENED : 0));
    }
    fingerprint = origin.value.get(2) ?? 0;
  }
  const parentFp = m.get(8) ?? (path.length === 1 ? fingerprint : 0);
  // Rebuild a BIP32 serialization so the rest of the wallet can use a normal HDKey.
  const raw = new Uint8Array(78);
  const version = testnet ? 0x043587cf : 0x0488b21e;
  const index = path.length ? path[path.length - 1] : 0;
  const be32 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  raw.set(be32(version), 0);
  raw[4] = path.length;
  raw.set(be32(parentFp >>> 0), 5);
  raw.set(be32(index >>> 0), 9);
  raw.set(chainCode, 13);
  raw.set(key, 45);
  const versions = testnet ? { public: 0x043587cf, private: 0x04358394 } : { public: 0x0488b21e, private: 0x0488ade4 };
  return { node: HDKey.fromExtendedKey(base58check.encode(raw), versions), path, fingerprint, testnet, coinType };
}

const PURPOSE_TYPE = Object.fromEntries(Object.entries(SCRIPT_TYPES).map(([type, { purpose }]) => [purpose + HARDENED, type]));

function outputFromCbor(exp) {
  let e = is(exp, 'output') ? exp.value : exp;
  let type;
  if (is(e, 'sh') && is(e.value, 'wpkh')) [type, e] = ['sh-wpkh', e.value.value];
  else if (is(e, 'pkh')) [type, e] = ['pkh', e.value];
  else if (is(e, 'wpkh')) [type, e] = ['wpkh', e.value];
  else if (is(e, 'tr')) [type, e] = ['tr', e.value];
  else return null; // multisig or other script types: not supported by this wallet
  return { type, ...hdkeyFromCbor(e) };
}

/** Accounts found in a scanned UR: crypto-account / crypto-output / crypto-hdkey (or v2 names). */
export function accountsFromUR(type, cbor) {
  const v = cborDecode(cbor);
  if (type === 'crypto-account') {
    if (!(v instanceof Map)) throw new WalletError('err.urContent');
    const fp = v.get(1);
    return (v.get(2) ?? []).map(outputFromCbor).filter(Boolean).map((a) => ({ ...a, fingerprint: a.fingerprint || fp }));
  }
  if (type === 'crypto-output' || type === 'output-descriptor') {
    const a = outputFromCbor(v instanceof Tagged ? v : new Tagged(T.output, v));
    return a ? [a] : [];
  }
  if (type === 'crypto-hdkey' || type === 'hdkey') {
    const a = hdkeyFromCbor(v instanceof Tagged ? v : new Tagged(T.hdkey, v));
    const purposeType = PURPOSE_TYPE[a.path[0]];
    return [{ ...a, type: purposeType ?? null }];
  }
  throw new WalletError('err.urType', { type });
}

export const ACCOUNT_UR_TYPES = ['crypto-account', 'crypto-output', 'output-descriptor', 'crypto-hdkey', 'hdkey'];
