// Recipient addresses → locking scripts, checked against the selected network.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { scureNet } from './networks.js';
import { decodeBase58Address, decodeCashAddr, encodeCashAddr } from './cashaddr.js';
import { WalletError } from './errors.js';

/**
 * Returns { address, script, kind } for a valid address on `net`, or throws err.address.
 * kind: pkh | sh | wpkh | wsh | tr | other. For BCH, legacy base58 is converted to CashAddr
 * (`converted: true`) and token-aware addresses are flagged.
 */
export function parseRecipient(net, text) {
  const s = String(text ?? '').trim();
  if (!s) throw new WalletError('err.address', { field: 'to' });
  return net.coin === 'bch' ? parseBch(net, s) : parseBtc(net, s);
}

function parseBtc(net, s) {
  let decoded;
  try {
    decoded = btc.Address(scureNet(net)).decode(s);
  } catch {
    throw new WalletError(looksLikeOtherNetwork(s) ? 'err.addressNetwork' : 'err.address', { field: 'to' });
  }
  const script = btc.OutScript.encode(decoded);
  const kind = ['pkh', 'sh', 'wpkh', 'wsh', 'tr'].includes(decoded.type) ? decoded.type : 'other';
  // bech32 is case-insensitive; show it in lower case.
  return { address: /^[a-z0-9]+1/i.test(s) ? s.toLowerCase() : s, script, kind };
}

const looksLikeOtherNetwork = (s) => /^(bc1|tb1|bcrt1|[123mn2])/i.test(s);

const P2PKH = (h) => hex.decode(`76a914${hex.encode(h)}88ac`);
const P2SH20 = (h) => hex.decode(`a914${hex.encode(h)}87`);
const P2SH32 = (h) => hex.decode(`aa20${hex.encode(h)}87`);

function parseBch(net, s) {
  const cash = decodeCashAddr(s, net.cashaddr);
  if (cash) {
    if (cash.prefix !== net.cashaddr) throw new WalletError('err.addressNetwork', { field: 'to' });
    const isSh = cash.type === 1 || cash.type === 3;
    if (cash.type > 3 || (!isSh && cash.hash.length !== 20) || (isSh && ![20, 32].includes(cash.hash.length))) {
      throw new WalletError('err.address', { field: 'to' });
    }
    const script = isSh ? (cash.hash.length === 32 ? P2SH32(cash.hash) : P2SH20(cash.hash)) : P2PKH(cash.hash);
    return {
      address: encodeCashAddr(net.cashaddr, cash.type, cash.hash),
      script,
      kind: isSh ? 'sh' : 'pkh',
      tokenAware: cash.type >= 2,
    };
  }
  const legacy = decodeBase58Address(s);
  if (legacy) {
    const [pkh, sh] = net.testnet ? [0x6f, 0xc4] : [0x00, 0x05];
    if (legacy.version !== pkh && legacy.version !== sh) throw new WalletError('err.addressNetwork', { field: 'to' });
    const isSh = legacy.version === sh;
    return {
      address: encodeCashAddr(net.cashaddr, isSh ? 1 : 0, legacy.hash),
      script: isSh ? P2SH20(legacy.hash) : P2PKH(legacy.hash),
      kind: isSh ? 'sh' : 'pkh',
      converted: true,
    };
  }
  throw new WalletError(/^(bc1|tb1)/i.test(s) ? 'err.addressNetwork' : 'err.address', { field: 'to' });
}

/** Locking script → display address (for reviewing outputs). Unknown scripts → ''. */
export function scriptToAddress(net, script) {
  if (net.coin === 'bch') {
    const h = hex.encode(script);
    let m = h.match(/^76a914([0-9a-f]{40})88ac$/);
    if (m) return encodeCashAddr(net.cashaddr, 0, hex.decode(m[1]));
    m = h.match(/^a914([0-9a-f]{40})87$/);
    if (m) return encodeCashAddr(net.cashaddr, 1, hex.decode(m[1]));
    m = h.match(/^aa20([0-9a-f]{64})87$/);
    if (m) return encodeCashAddr(net.cashaddr, 1, hex.decode(m[1]));
    return '';
  }
  try {
    return btc.Address(scureNet(net)).encode(btc.OutScript.decode(script));
  } catch {
    return '';
  }
}
