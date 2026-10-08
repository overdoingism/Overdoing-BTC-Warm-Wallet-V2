// What a scanned QR code or pasted text is, so one "Scan" button can handle everything.
import { base64, hex } from '@scure/base';
import { parseRecipient } from './address.js';
import { parseDescriptor, parseXpub } from './keys.js';
import { WalletError } from './errors.js';

const MAX = 200_000;
const PSBT_MAGIC = '70736274ff';

/** BIP21 / CashAddr payment URI → { address, amount?, label? } (amount in coins as a string). */
function parseUri(text, net) {
  const m = text.match(/^(bitcoin|bitcoincash|bchtest|bchreg):([^?]+)(?:\?(.*))?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if ((net.coin === 'btc') !== (scheme === 'bitcoin')) throw new WalletError('err.addressNetwork', { field: 'qr' });
  const addrText = net.coin === 'bch' && !m[2].includes(':') ? `${scheme}:${m[2]}` : m[2];
  const { address } = parseRecipient(net, addrText);
  const params = new URLSearchParams(m[3] ?? '');
  const amount = params.get('amount') ?? undefined;
  if (amount !== undefined && !/^\d+(\.\d{1,8})?$/.test(amount)) throw new WalletError('err.number', { field: 'amount' });
  return { kind: 'payment', address, amount, label: params.get('label') ?? params.get('message') ?? undefined };
}

const ARMOR_RE = /-----BEGIN BITCOIN SIGNED MESSAGE-----\r?\n([\s\S]*?)\r?\n-----BEGIN (?:BITCOIN )?SIGNATURE-----\r?\n([^\r\n]+)\r?\n([^\r\n]+)\r?\n-----END BITCOIN SIGNED MESSAGE-----/;

export function formatSignedMessage({ address, message, signature }) {
  return `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${message}\n-----BEGIN SIGNATURE-----\n${address}\n${signature}\n-----END BITCOIN SIGNED MESSAGE-----`;
}

export const encodeMessageRequest = ({ address, message }) => JSON.stringify({ oebw: 'msg', v: 1, address, msg: message });

/**
 * Returns one of:
 *   { kind: 'ur' }                                  (feed to a URDecoder)
 *   { kind: 'payment', address, amount?, label? }   (BIP21 / plain address)
 *   { kind: 'account', parsed }                     (xpub / ypub / zpub / descriptor)
 *   { kind: 'psbt', bytes } | { kind: 'rawtx', hex }
 *   { kind: 'msgRequest', address, message } | { kind: 'signature', address, message, signature }
 *   { kind: 'unknown' }
 */
export function classify(input, net) {
  const text = String(input ?? '').trim();
  if (!text || text.length > MAX) return { kind: 'unknown' };
  if (/^ur:/i.test(text)) return { kind: 'ur' };

  const armored = text.match(ARMOR_RE);
  if (armored) return { kind: 'signature', message: armored[1], address: armored[2].trim(), signature: armored[3].trim() };

  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text);
      if (o?.oebw === 'msg' && o.v === 1 && typeof o.address === 'string' && typeof o.msg === 'string') return { kind: 'msgRequest', address: o.address, message: o.msg };
      if (typeof o?.address === 'string' && typeof o.signature === 'string' && typeof o.message === 'string') return { kind: 'signature', address: o.address, message: o.message, signature: o.signature };
    } catch {
      // not JSON
    }
    return { kind: 'unknown' };
  }

  if (/^cHNidP8/.test(text)) {
    try {
      return { kind: 'psbt', bytes: base64.decode(text.replace(/\s+/g, '')) };
    } catch {
      return { kind: 'unknown' };
    }
  }
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 && text.length > 120) {
    const lower = text.toLowerCase();
    return lower.startsWith(PSBT_MAGIC) ? { kind: 'psbt', bytes: hex.decode(lower) } : { kind: 'rawtx', hex: lower };
  }

  const uri = parseUri(text, net);
  if (uri) return uri;
  try {
    return { kind: 'payment', address: parseRecipient(net, text).address };
  } catch {
    // not an address of this network
  }
  const desc = /[()]/.test(text) ? parseDescriptor(text) : null;
  if (desc) return { kind: 'account', parsed: desc };
  const xpub = parseXpub(text);
  if (xpub) return { kind: 'account', parsed: { ...xpub, type: xpub.impliedType ?? undefined } };
  return { kind: 'unknown' };
}
