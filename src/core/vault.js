// Password-encrypted mnemonic storage in the browser (localStorage).
// scrypt (N=2^17, r=8, p=1) → 256-bit key → AES-256-GCM. The BIP39 passphrase is never stored;
// the master fingerprint is kept inside the encrypted blob to recognize a wrong passphrase.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { base64 } from '@scure/base';
import { WalletError } from './errors.js';

export const VAULT_KEY = 'oebw.vault.v1';
export const DEFAULT_N = 1 << 17;
const MAX_N = 1 << 20;
const te = new TextEncoder();
const td = new TextDecoder();

async function deriveKey(password, salt, n, onProgress) {
  if (!password) throw new WalletError('err.passwordEmpty');
  return scryptAsync(te.encode(password.normalize('NFKC')), salt, { N: n, r: 8, p: 1, dkLen: 32, onProgress });
}

export async function encryptSecret(secret, password, { n = DEFAULT_N, onProgress } = {}) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(password, salt, n, onProgress);
  const ct = gcm(key, nonce).encrypt(te.encode(JSON.stringify(secret)));
  return { v: 1, kdf: 'scrypt', n, salt: base64.encode(salt), nonce: base64.encode(nonce), ct: base64.encode(ct) };
}

export async function decryptSecret(blob, password, { onProgress } = {}) {
  if (!blob || blob.v !== 1 || blob.kdf !== 'scrypt' || !Number.isSafeInteger(blob.n) || blob.n > MAX_N || blob.n & (blob.n - 1)) {
    throw new WalletError('err.vaultFormat');
  }
  const key = await deriveKey(password, base64.decode(blob.salt), blob.n, onProgress);
  let plain;
  try {
    plain = gcm(key, base64.decode(blob.nonce)).decrypt(base64.decode(blob.ct));
  } catch {
    throw new WalletError('err.vaultPassword');
  }
  return JSON.parse(td.decode(plain));
}

export function createVault(storage) {
  const read = () => {
    let raw;
    try {
      raw = storage.getItem(VAULT_KEY);
    } catch {
      throw new WalletError('err.storage');
    }
    try {
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((e) => e?.id && e.blob) : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      storage.setItem(VAULT_KEY, JSON.stringify(list));
    } catch {
      throw new WalletError('err.storage');
    }
  };
  return {
    /** Public listing: names only. Addresses and keys stay inside the encrypted blob. */
    list: () => read().map(({ id, name, created }) => ({ id, name, created })),
    async add(name, secret, password, opts) {
      const entry = {
        id: Array.from(randomBytes(8), (b) => b.toString(16).padStart(2, '0')).join(''),
        name: String(name || '').trim().slice(0, 40) || 'Wallet',
        created: new Date().toISOString(),
        blob: await encryptSecret(secret, password, opts),
      };
      write([...read(), entry]);
      return entry;
    },
    async unlock(id, password, opts) {
      const entry = read().find((e) => e.id === id);
      if (!entry) throw new WalletError('err.vaultMissing');
      return decryptSecret(entry.blob, password, opts);
    },
    remove(id) {
      write(read().filter((e) => e.id !== id));
    },
  };
}
