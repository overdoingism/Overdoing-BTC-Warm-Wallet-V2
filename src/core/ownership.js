// "Is this input/output ours?" — decided by re-deriving the key and comparing the locking
// script, never by trusting labels in the PSBT.
import { hex } from '@scure/base';
import { deriveAddress, privateKeyFor } from './keys.js';

const SEARCH_LIMIT = 200; // per chain, for PSBTs that carry no derivation info

export function makeIsMine(account) {
  let searched;
  const searchIndex = () => {
    if (!searched) {
      searched = new Map();
      for (const chain of [0, 1]) {
        for (let index = 0; index < SEARCH_LIMIT; index++) {
          const a = deriveAddress(account, chain, index);
          searched.set(hex.encode(a.script), { path: a.path, chain, index });
        }
      }
    }
    return searched;
  };
  return (script, derivations = []) => {
    const sHex = hex.encode(script);
    if (account.kind === 'single') return hex.encode(account.script) === sHex ? { path: undefined } : null;
    for (const d of derivations) {
      const p = d.path ?? [];
      if (p.length !== account.path.length + 2 || !account.path.every((v, i) => v === p[i])) continue;
      if (account.fingerprint && d.fingerprint && d.fingerprint >>> 0 !== account.fingerprint >>> 0) continue;
      const [chain, index] = p.slice(-2);
      if (chain > 1 || index >= 0x80000000) continue;
      const a = deriveAddress(account, chain, index);
      if (hex.encode(a.script) === sHex) return { path: a.path, chain, index };
    }
    // Only fall back to searching when the PSBT says nothing about where the key is.
    if (derivations.length === 0) return searchIndex().get(sHex) ?? null;
    return null;
  };
}

export const makeKeyFor = (account) => (input) => (input.mine ? privateKeyFor(account, input.mine.path) : undefined);
