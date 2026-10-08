// Keys and accounts: BIP39 mnemonics, BIP32/44/49/84/86 HD accounts, extended public keys
// (incl. SLIP-132 ypub/zpub), output descriptors (BIP380), WIF keys and single addresses.
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { wordlist as traditionalChinese } from '@scure/bip39/wordlists/traditional-chinese.js';
import { wordlist as simplifiedChinese } from '@scure/bip39/wordlists/simplified-chinese.js';
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as btc from '@scure/btc-signer';
import { SCRIPT_TYPES, scureNet } from './networks.js';
import { encodeCashAddr } from './cashaddr.js';
import { WalletError } from './errors.js';

const base58check = createBase58check(sha256);
export const hash160 = (b) => ripemd160(sha256(b));
const HARDENED = 0x80000000;

// ---------------------------------------------------------------- BIP39 mnemonics
const WORDLISTS = [
  ['english', english],
  ['traditionalChinese', traditionalChinese],
  ['simplifiedChinese', simplifiedChinese],
];
const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24];
const HAN_RE = /\p{Script=Han}/u;

/** Canonical BIP39 sentence: NFKD, lower case, single spaces; Chinese split per character. */
export function normalizeMnemonic(text) {
  const s = String(text ?? '').normalize('NFKD').trim().toLowerCase();
  if (HAN_RE.test(s)) return Array.from(s.replace(/\s+/g, '')).join(' ');
  return s.split(/\s+/).filter(Boolean).join(' ');
}

/** status: 'ok' | 'badLength' | 'badChecksum' | 'unknownWords' (see the ETH wallet for details). */
export function inspectMnemonic(text) {
  const phrase = normalizeMnemonic(text);
  const words = phrase ? phrase.split(' ') : [];
  const base = { phrase, wordCount: words.length };
  if (!MNEMONIC_LENGTHS.includes(words.length)) return { ...base, status: 'badLength' };
  for (const [name, list] of WORDLISTS) {
    if (validateMnemonic(phrase, list)) return { ...base, status: 'ok', wordlist: name };
  }
  let best;
  for (const [name, list] of WORDLISTS) {
    const known = new Set(list);
    const unknown = words.filter((w) => !known.has(w));
    if (unknown.length === 0) return { ...base, status: 'badChecksum', wordlist: name };
    if (!best || unknown.length < best.unknown.length) best = { wordlist: name, unknown };
  }
  return { ...base, status: 'unknownWords', unknownWords: [...new Set(best.unknown)] };
}

// ---------------------------------------------------------------- derivation paths
/** "m/84'/0'/0'" (h/H/’ accepted) → [0x80000054, 0x80000000, 0x80000000]. */
export function parsePath(path) {
  const p = String(path ?? '').trim().replace(/^M/, 'm').replace(/[hH’‘′]/g, "'");
  if (!/^m(\/\d+'?)*$/.test(p)) throw new WalletError('err.path');
  return p
    .split('/')
    .slice(1)
    .map((seg) => {
      const n = parseInt(seg, 10);
      if (n >= HARDENED) throw new WalletError('err.path');
      return seg.endsWith("'") ? n + HARDENED : n;
    });
}

export const formatPath = (indexes) =>
  'm' + indexes.map((i) => '/' + (i >= HARDENED ? `${i - HARDENED}'` : String(i))).join('');

export const accountPath = (net, type, account = 0) => `m/${SCRIPT_TYPES[type].purpose}'/${net.coinType}'/${account}'`;

// ---------------------------------------------------------------- scripts & addresses
/** Locking script and address for one public key of a given account type. */
export function scriptFor(net, type, pubkey) {
  const n = scureNet(net);
  let pay;
  if (type === 'pkh') pay = btc.p2pkh(pubkey, n);
  else if (type === 'wpkh') pay = btc.p2wpkh(pubkey, n);
  else if (type === 'sh-wpkh') pay = btc.p2sh(btc.p2wpkh(pubkey, n), n);
  else if (type === 'tr') pay = btc.p2tr(pubkey.length === 33 ? pubkey.slice(1) : pubkey, undefined, n);
  else throw new WalletError('err.scriptType');
  const address = net.coin === 'bch' ? encodeCashAddr(net.cashaddr, 0, hash160(pubkey)) : pay.address;
  return { address, script: pay.script, redeemScript: pay.redeemScript, tapInternalKey: pay.tapInternalKey };
}

// ---------------------------------------------------------------- accounts
// An account is either 'hd' (an account-level extended key: many addresses) or 'single'
// (one address). It can sign when it carries the master key (mnemonic) or a WIF key.

export function rootFromMnemonic(phrase, passphrase, net) {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(normalizeMnemonic(phrase), passphrase ?? ''), net.bip32);
}

export function hdAccountFromRoot(root, net, type, path) {
  const indexes = parsePath(path);
  const node = root.derive(formatPath(indexes));
  return {
    kind: 'hd',
    net,
    type,
    fingerprint: root.fingerprint,
    path: indexes,
    node: HDKey.fromExtendedKey(node.publicExtendedKey, net.bip32),
    root,
  };
}

/** One address of an HD account: chain 0 = receive, 1 = change. */
export function deriveAddress(account, chain, index) {
  if (account.kind === 'single') return { ...singleInfo(account), chain: 0, index: 0 };
  const child = account.node.deriveChild(chain).deriveChild(index);
  return {
    ...scriptFor(account.net, account.type, child.publicKey),
    pubkey: child.publicKey,
    chain,
    index,
    path: [...account.path, chain, index],
  };
}

const singleInfo = (account) => ({
  address: account.address,
  script: account.script,
  redeemScript: account.redeemScript,
  tapInternalKey: account.tapInternalKey,
  pubkey: account.pubkey,
  path: undefined,
});

/** Private key for an address of this account (hd: derived from the master key). */
export function privateKeyFor(account, path) {
  if (account.kind === 'single') return account.privateKey;
  if (!account.root) throw new WalletError('err.watchOnly');
  return account.root.derive(formatPath(path)).privateKey;
}

// ---------------------------------------------------------------- extended public keys
// SLIP-132 version bytes → [testnet, implied script type].
const XPUB_VERSIONS = {
  0x0488b21e: [false, null], // xpub (pkh or tr — ambiguous)
  0x049d7cb2: [false, 'sh-wpkh'], // ypub
  0x04b24746: [false, 'wpkh'], // zpub
  0x043587cf: [true, null], // tpub
  0x044a5262: [true, 'sh-wpkh'], // upub
  0x045f1cf6: [true, 'wpkh'], // vpub
};
const SLIP132 = { 'sh-wpkh': [0x049d7cb2, 0x044a5262], wpkh: [0x04b24746, 0x045f1cf6] };

/** Parses any xpub/ypub/zpub/tpub/upub/vpub → { node, testnet, impliedType }. */
export function parseXpub(text) {
  let raw;
  try {
    raw = base58check.decode(String(text ?? '').trim());
  } catch {
    return null;
  }
  if (raw.length !== 78) return null;
  const version = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  const known = XPUB_VERSIONS[version];
  if (!known) return null;
  const [testnet, impliedType] = known;
  const std = Uint8Array.from(raw);
  std.set(testnet ? [0x04, 0x35, 0x87, 0xcf] : [0x04, 0x88, 0xb2, 0x1e], 0);
  const node = HDKey.fromExtendedKey(base58check.encode(std), testnet ? { public: 0x043587cf, private: 0x04358394 } : { public: 0x0488b21e, private: 0x0488ade4 });
  if (node.privateKey) return null;
  return { node, testnet, impliedType };
}

/** Account xpub in the conventional form for its type (zpub/vpub for P2WPKH, ypub/upub for P2SH-P2WPKH). */
export function displayXpub(account, slip132 = true) {
  const xpub = account.node.publicExtendedKey;
  const versions = slip132 && account.net.coin === 'btc' ? SLIP132[account.type] : undefined;
  if (!versions) return xpub;
  const raw = Uint8Array.from(base58check.decode(xpub));
  const v = versions[account.net.testnet ? 1 : 0];
  raw.set([v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255], 0);
  return base58check.encode(raw);
}

export function hdAccountFromXpub(node, net, type, fingerprint = 0, path) {
  return {
    kind: 'hd',
    net,
    type,
    fingerprint,
    path: path ?? [...parsePath(`m/${SCRIPT_TYPES[type].purpose}'/${net.coinType}'/0'`)],
    node,
    originKnown: !!fingerprint,
  };
}

// ---------------------------------------------------------------- output descriptors (BIP380)
const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const DESC_GEN = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function descPolymod(symbols) {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) chk ^= DESC_GEN[i];
  }
  return chk;
}

export function descriptorChecksum(desc) {
  const symbols = [];
  let groups = [];
  for (const c of desc) {
    const v = INPUT_CHARSET.indexOf(c);
    if (v < 0) return null;
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups = [];
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  else if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  const chk = descPolymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  return Array.from({ length: 8 }, (_, i) => CHECKSUM_CHARSET[Number((chk >> BigInt(5 * (7 - i))) & 31n)]).join('');
}

const fpHex = (fp) => (fp >>> 0).toString(16).padStart(8, '0');

/** wpkh([fingerprint/84'/0'/0']xpub…/<0;1>/*)#checksum */
export function formatDescriptor(account) {
  const origin = `[${fpHex(account.fingerprint)}${formatPath(account.path).slice(1)}]`;
  const key = `${origin}${account.node.publicExtendedKey}/<0;1>/*`;
  const body = { pkh: `pkh(${key})`, wpkh: `wpkh(${key})`, 'sh-wpkh': `sh(wpkh(${key}))`, tr: `tr(${key})` }[account.type];
  return `${body}#${descriptorChecksum(body)}`;
}

const DESC_RE = /^(pkh|wpkh|tr|sh\(wpkh)\((?:\[([0-9a-fA-F]{8})((?:\/\d+['hH]?)*)\])?([1-9A-HJ-NP-Za-km-z]{100,120})((?:\/(?:\d+['hH]?|<\d+;\d+>|\*))*)\)\)?$/;

/** Parses a single-key descriptor → { type, fingerprint, path, node, testnet }; null if not one. */
export function parseDescriptor(text) {
  let s = String(text ?? '').trim();
  const hash = s.indexOf('#');
  if (hash >= 0) {
    const [body, sum] = [s.slice(0, hash), s.slice(hash + 1)];
    if (descriptorChecksum(body) !== sum) throw new WalletError('err.descChecksum');
    s = body;
  }
  const m = s.match(DESC_RE);
  if (!m) return null;
  const [, wrap, fp, originPath, xpub, suffix] = m;
  const isSh = wrap === 'sh(wpkh';
  if (isSh !== s.endsWith('))')) return null;
  const type = isSh ? 'sh-wpkh' : wrap;
  if (suffix && !/^(\/(0|1|<0;1>)\/\*)?$/.test(suffix)) throw new WalletError('err.descUnsupported');
  const parsed = parseXpub(xpub);
  if (!parsed) return null;
  return {
    type,
    fingerprint: fp ? parseInt(fp, 16) >>> 0 : 0,
    path: originPath ? parsePath('m' + originPath) : undefined,
    node: parsed.node,
    testnet: parsed.testnet,
  };
}

// ---------------------------------------------------------------- single keys & addresses
/** WIF private key (compressed only) → { privateKey, testnet }. */
export function parseWif(text) {
  let raw;
  try {
    raw = base58check.decode(String(text ?? '').trim());
  } catch {
    return null;
  }
  if ((raw[0] !== 0x80 && raw[0] !== 0xef) || (raw.length !== 34 && raw.length !== 33)) return null;
  if (raw.length === 33) throw new WalletError('err.uncompressedWif');
  if (raw[33] !== 0x01) return null;
  const privateKey = raw.slice(1, 33);
  if (!secp256k1.utils.isValidSecretKey(privateKey)) throw new WalletError('err.privateKey');
  return { privateKey, testnet: raw[0] === 0xef };
}

export function singleAccountFromWif(privateKey, net, type) {
  const pubkey = secp256k1.getPublicKey(privateKey, true);
  return { kind: 'single', net, type, privateKey, pubkey, ...scriptFor(net, type, pubkey) };
}

/** Watch-only account for one address; `script` comes from address.js. */
export const singleAccountFromAddress = (net, type, address, script) => ({ kind: 'single', net, type, address, script });

export const canSign = (account) => !!(account && (account.root || account.privateKey));
