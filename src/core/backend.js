// Blockchain data sources. One interface, two implementations:
//   Esplora REST (https://…)            mempool.space, Blockstream, or a self-hosted instance
//   Electrum protocol over WebSocket    Fulcrum / ElectrumX servers (wss://… or ws://…)
// Everything is looked up by locking script, so the same code serves BTC and BCH.
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { WalletError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COIN = 100_000_000;

export function createBackend(url, net) {
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  if (/^wss?:\/\/\S+$/i.test(u)) return electrumBackend(u, net);
  if (/^https?:\/\/\S+$/i.test(u)) {
    if (net.coin === 'bch') throw new WalletError('err.bchNeedsElectrum');
    return esploraBackend(u);
  }
  throw new WalletError('err.serverUrl');
}

/** Small concurrency limiter so public servers are not hammered. */
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// ---------------------------------------------------------------- Esplora
function esploraBackend(base) {
  const limit = limiter(4);
  async function req(path, { method = 'GET', body, text = false } = {}) {
    return limit(async () => {
      for (let attempt = 0; ; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20_000);
        let res;
        try {
          res = await fetch(base + path, { method, body, signal: ctrl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
        } catch (e) {
          throw new WalletError(e?.name === 'AbortError' ? 'err.serverTimeout' : 'err.serverNetwork', { detail: e?.message ?? String(e) });
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 429 && attempt < 3) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        const payload = await res.text();
        if (!res.ok) throw new WalletError('err.serverReply', { status: res.status, detail: payload.slice(0, 200) });
        if (text) return payload.trim();
        try {
          return JSON.parse(payload);
        } catch {
          throw new WalletError('err.serverReply', { status: res.status, detail: payload.slice(0, 200) });
        }
      }
    });
  }
  return {
    kind: 'esplora',
    url: base,
    async tipHeight() {
      return Number(await req('/blocks/tip/height', { text: true }));
    },
    async feeRates() {
      const est = await req('/fee-estimates');
      const pick = (...targets) => {
        for (const t of targets) if (est[t] !== undefined) return Math.round(est[t] * 100) / 100;
        return 1;
      };
      return { fast: pick('1', '2', '3'), normal: pick('6', '5', '4'), slow: pick('144', '25', '12') };
    },
    async addressInfos(items) {
      return Promise.all(
        items.map(async ({ address }) => {
          const a = await req(`/address/${address}`);
          const c = a.chain_stats;
          const m = a.mempool_stats;
          return {
            used: c.tx_count + m.tx_count > 0,
            confirmed: BigInt(c.funded_txo_sum - c.spent_txo_sum),
            unconfirmed: BigInt(m.funded_txo_sum - m.spent_txo_sum),
          };
        }),
      );
    },
    async utxos({ address }) {
      const list = await req(`/address/${address}/utxo`);
      return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), height: u.status?.confirmed ? u.status.block_height : 0 }));
    },
    async history({ address }) {
      const txs = await req(`/address/${address}/txs`);
      return txs.map((t) => ({ txid: t.txid, height: t.status?.confirmed ? t.status.block_height : 0 }));
    },
    txHex: (txid) => req(`/tx/${txid}/hex`, { text: true }),
    broadcast: (rawHex) => req('/tx', { method: 'POST', body: rawHex, text: true }),
    close() {},
  };
}

// ---------------------------------------------------------------- Electrum over WebSocket
export const scripthash = (script) => hex.encode(sha256(script).reverse());

function electrumBackend(url, net) {
  let ws;
  let ready;
  let nextId = 0;
  const pending = new Map();

  function fail(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    ws = undefined;
    ready = undefined;
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new WalletError('err.serverNetwork', { detail: e?.message ?? String(e) }));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new WalletError('err.serverTimeout'));
      }, 15_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        const err = new WalletError('err.serverNetwork', { detail: url });
        reject(err);
        fail(err);
      };
      ws.onclose = () => fail(new WalletError('err.serverClosed'));
      ws.onmessage = (ev) => {
        for (const line of String(ev.data).split('\n')) {
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          for (const m of Array.isArray(msg) ? msg : [msg]) {
            const p = pending.get(m.id);
            if (!p) continue; // notifications
            pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.error) p.reject(new WalletError('err.serverRpc', { detail: m.error.message ?? JSON.stringify(m.error) }));
            else p.resolve(m.result);
          }
        }
      };
    }).then(() => call('server.version', ['OverdoingWallet', '1.4']).then(() => undefined));
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  }

  function call(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new WalletError('err.serverTimeout'));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async function rpc(method, params) {
    await connect();
    return call(method, params);
  }

  /** Many calls in one go (servers handle them concurrently). */
  async function many(method, paramsList) {
    await connect();
    return Promise.all(paramsList.map((params) => call(method, params)));
  }

  const perKb = (v) => (typeof v === 'number' && v > 0 ? Math.round(v * COIN) / 1000 : undefined); // BTC/kB → sat/vB

  return {
    kind: 'electrum',
    url,
    async tipHeight() {
      const h = await rpc('blockchain.headers.subscribe', []);
      return h.height ?? h.block_height;
    },
    async feeRates() {
      const relay = perKb(await rpc('blockchain.relayfee', []).catch(() => undefined)) ?? 1;
      if (net.coin === 'bch') {
        const r = Math.max(1, relay);
        return { fast: r, normal: r, slow: r };
      }
      const [f, n, s] = await many('blockchain.estimatefee', [[2], [6], [24]]).catch(() => []);
      const floor = (v) => Math.max(relay, perKb(v) ?? relay);
      return { fast: floor(f), normal: floor(n), slow: floor(s) };
    },
    async addressInfos(items) {
      const hashes = items.map(({ script }) => [scripthash(script)]);
      const [hist, bal] = await Promise.all([many('blockchain.scripthash.get_history', hashes), many('blockchain.scripthash.get_balance', hashes)]);
      return items.map((_, i) => ({ used: hist[i].length > 0, confirmed: BigInt(bal[i].confirmed), unconfirmed: BigInt(bal[i].unconfirmed) }));
    },
    async utxos({ script }) {
      const list = await rpc('blockchain.scripthash.listunspent', [scripthash(script)]);
      return list.map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, value: BigInt(u.value), height: u.height > 0 ? u.height : 0, token: !!u.token_data }));
    },
    async history({ script }) {
      const list = await rpc('blockchain.scripthash.get_history', [scripthash(script)]);
      return list.map((t) => ({ txid: t.tx_hash, height: t.height > 0 ? t.height : 0 }));
    },
    txHex: (txid) => rpc('blockchain.transaction.get', [txid, false]),
    broadcast: (rawHex) => rpc('blockchain.transaction.broadcast', [rawHex]),
    close() {
      try {
        ws?.close();
      } catch {}
      fail(new WalletError('err.serverClosed'));
    },
  };
}
