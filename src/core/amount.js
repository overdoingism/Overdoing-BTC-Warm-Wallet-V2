import { WalletError } from './errors.js';

// Amounts are always bigint satoshis internally; 1 BTC = 1 BCH = 10^8 sat.
export const COIN = 100_000_000n;
const DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const MAX_SUPPLY = 21_000_000n * COIN;

/** "0.015" → 1_500_000n. Strict: no signs, exponents or more than 8 decimals. */
export function parseCoins(input, field = 'amount') {
  const s = String(input ?? '').trim();
  if (!DECIMAL_RE.test(s)) throw new WalletError('err.number', { field });
  const [int, frac = ''] = s.split('.');
  if (frac.length > 8) throw new WalletError('err.tooManyDecimals', { field, decimals: 8 });
  const sats = BigInt((int || '0') + frac.padEnd(8, '0'));
  if (sats > MAX_SUPPLY) throw new WalletError('err.range', { field });
  return sats;
}

/** 1_500_000n → "0.015" (trailing zeros trimmed). */
export function formatCoins(sats) {
  const v = BigInt(sats);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / COIN;
  const frac = (abs % COIN).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

/** Fee rate in sat/vB; decimals allowed (Bitcoin Core relays below 1 sat/vB). */
export function parseFeeRate(input) {
  const s = String(input ?? '').trim();
  if (!DECIMAL_RE.test(s)) throw new WalletError('err.number', { field: 'feeRate' });
  const rate = Number(s);
  if (!(rate > 0) || rate > 10_000) throw new WalletError('err.feeRate');
  return rate;
}

export function parseInteger(input, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const s = String(input ?? '').trim();
  if (!/^\d+$/.test(s)) throw new WalletError('err.integer', { field });
  const v = Number(s);
  if (v < min || v > max) throw new WalletError('err.range', { field });
  return v;
}
