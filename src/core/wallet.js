// Account discovery (BIP44 gap limit), UTXO set, building transfers and RBF fee bumps.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { deriveAddress } from './keys.js';
import { RBF_SEQUENCE, NO_RBF_SEQUENCE, buildBtcPsbt, inputFor } from './btc.js';
import { buildBchPsbt, selectCoins } from './bch.js';
import { WalletError } from './errors.js';

export const GAP_LIMIT = 20;
const BTC_DUST = 546n;

const keyOf = (u) => `${u.txid}:${u.vout}`;

/**
 * Scans an account: every used address on the receive (0) and change (1) chains until
 * GAP_LIMIT unused ones in a row, then the unspent outputs of the used ones.
 */
export async function scanAccount(account, backend, { gap = GAP_LIMIT, onProgress } = {}) {
  const addrs = new Map();
  const lastUsed = [-1, -1];
  const record = (a, info) => {
    addrs.set(hex.encode(a.script), { ...a, ...info });
    if (info.used) lastUsed[a.chain] = Math.max(lastUsed[a.chain], a.index);
  };
  if (account.kind === 'single') {
    const a = deriveAddress(account, 0, 0);
    record(a, (await backend.addressInfos([a]))[0]);
  } else {
    for (const chain of [0, 1]) {
      let next = 0;
      while (next <= lastUsed[chain] + gap) {
        const end = lastUsed[chain] + gap;
        const batch = [];
        for (let i = next; i <= end; i++) batch.push(deriveAddress(account, chain, i));
        const infos = await backend.addressInfos(batch);
        batch.forEach((a, k) => record(a, infos[k]));
        next = end + 1;
        onProgress?.({ chain, scanned: next });
      }
    }
  }
  const used = [...addrs.values()].filter((a) => a.used);
  const lists = await Promise.all(used.map((a) => backend.utxos(a).then((list) => list.map((u) => ({ ...u, addr: a })))));
  const utxos = [];
  let tokenUtxos = 0;
  for (const u of lists.flat()) {
    if (u.token) {
      tokenUtxos++; // CashTokens: spending these as plain BCH would burn the tokens
      continue;
    }
    const { addr, ...rest } = u;
    utxos.push({ ...rest, key: keyOf(u), type: account.type, ...pickAddr(addr) });
  }
  utxos.sort((a, b) => (a.height === 0) - (b.height === 0) || a.height - b.height);
  let confirmed = 0n;
  let unconfirmed = 0n;
  for (const a of addrs.values()) {
    confirmed += a.confirmed ?? 0n;
    unconfirmed += a.unconfirmed ?? 0n;
  }
  const [tip, fees] = await Promise.all([backend.tipHeight(), backend.feeRates().catch(() => null)]);
  return {
    addrs,
    utxos,
    tokenUtxos,
    balance: { confirmed, unconfirmed },
    receive: account.kind === 'single' ? deriveAddress(account, 0, 0) : deriveAddress(account, 0, lastUsed[0] + 1),
    change: account.kind === 'single' ? deriveAddress(account, 0, 0) : deriveAddress(account, 1, lastUsed[1] + 1),
    tip,
    fees,
  };
}

const pickAddr = (a) => ({
  address: a.address,
  script: a.script,
  chain: a.chain,
  index: a.index,
  path: a.path,
  pubkey: a.pubkey,
  redeemScript: a.redeemScript,
  tapInternalKey: a.tapInternalKey,
});

/** Full previous transactions, cached for the session. */
export function prevTxLoader(backend) {
  const cache = new Map();
  return (txid) => {
    if (!cache.has(txid)) {
      const p = backend.txHex(txid).then((h) => hex.decode(h));
      p.catch(() => cache.delete(txid));
      cache.set(txid, p);
    }
    return cache.get(txid);
  };
}

/**
 * Builds an unsigned transfer. `selectedKeys` (coin control) spends exactly those coins.
 * Returns { psbt, fee, vsize }.
 */
export async function prepareTransfer({ account, state, loadPrevTx }, { to, amount, max, feeRate, rbf = true, selectedKeys }) {
  let utxos = state.utxos;
  if (selectedKeys?.length) utxos = utxos.filter((u) => selectedKeys.includes(u.key));
  if (!utxos.length) throw new WalletError('err.noUtxos');
  const useAll = !!selectedKeys?.length;

  if (account.net.coin === 'bch') {
    const sel = selectCoins(utxos, { amount, max, all: useAll, recipientScript: to.script, changeScript: state.change.script, feeRate });
    const inputs = await Promise.all(
      sel.inputs.map(async (u) => ({ txid: u.txid, vout: u.vout, prevTx: await loadPrevTx(u.txid), pubkey: u.pubkey, path: u.path, fingerprint: account.fingerprint })),
    );
    const outputs = [{ script: to.script, amount: sel.amount }];
    const c = state.change;
    if (sel.change > 0n) outputs.push({ script: c.script, amount: sel.change, pubkey: c.pubkey, path: c.path, fingerprint: account.fingerprint });
    return { psbt: buildBchPsbt({ inputs, outputs, lockTime: state.tip }), fee: sel.fee, vsize: sel.size };
  }

  const sequence = rbf ? RBF_SEQUENCE : NO_RBF_SEQUENCE;
  const common = { account, to, amount, max, feeRate, change: state.change, lockTime: state.tip };
  const withPrev = async (list) =>
    Promise.all(list.map(async (u) => ({ ...u, sequence, prevTx: u.type === 'tr' ? undefined : await loadPrevTx(u.txid) })));
  // Legacy coins need their previous transactions even to be selected; for SegWit we select
  // first and fetch only what is actually spent.
  if (account.type === 'pkh' || max || useAll) return buildBtcPsbt({ ...common, utxos: await withPrev(utxos), useAll });
  const draft = buildBtcPsbt({ ...common, utxos: utxos.map((u) => ({ ...u, sequence })), selectionOnly: true });
  const chosen = btc.Transaction.fromPSBT(draft.psbt, { allowUnknownOutputs: true });
  const keys = new Set();
  for (let i = 0; i < chosen.inputsLength; i++) {
    const inp = chosen.getInput(i);
    keys.add(`${hex.encode(inp.txid)}:${inp.index}`);
  }
  return buildBtcPsbt({ ...common, utxos: await withPrev(utxos.filter((u) => keys.has(u.key))), useAll: true });
}

/**
 * Replace-by-fee: re-spends the same inputs with a higher fee taken from our change output.
 * All inputs must be ours.
 */
export async function prepareBump({ account, state, backend, loadPrevTx }, { txid, feeRate }) {
  const orig = btc.Transaction.fromRaw(hex.decode(await backend.txHex(txid)), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const utxos = [];
  let totalIn = 0n;
  for (let i = 0; i < orig.inputsLength; i++) {
    const inp = orig.getInput(i);
    const prevId = hex.encode(inp.txid);
    const prevTx = await loadPrevTx(prevId);
    const out = btc.RawTx.decode(prevTx).outputs[inp.index];
    const mine = out && state.addrs.get(hex.encode(out.script));
    if (!mine) throw new WalletError('err.bumpForeign');
    totalIn += out.amount;
    utxos.push({ txid: prevId, vout: inp.index, value: out.amount, type: account.type, ...pickAddr(mine), prevTx: account.type === 'tr' ? undefined : prevTx, sequence: RBF_SEQUENCE });
  }
  let totalOut = 0n;
  let changeIdx = -1;
  const outputs = [];
  for (let i = 0; i < orig.outputsLength; i++) {
    const o = orig.getOutput(i);
    totalOut += o.amount;
    const mine = state.addrs.get(hex.encode(o.script));
    if (mine && (mine.chain === 1 || account.kind === 'single') && changeIdx < 0) changeIdx = i;
    outputs.push({ script: o.script, amount: o.amount, mine });
  }
  if (changeIdx < 0) throw new WalletError('err.bumpNoChange');
  const oldFee = totalIn - totalOut;
  const vsize = orig.vsize;
  // BIP125: the replacement must pay at least the old fee plus its own size at the relay rate.
  const newFee = [BigInt(Math.ceil(vsize * feeRate)), oldFee + BigInt(vsize)].reduce((a, b) => (a > b ? a : b));
  const newChange = outputs[changeIdx].amount - (newFee - oldFee);
  if (newChange < BTC_DUST) throw new WalletError('err.bumpNoChange');
  const tx = new btc.Transaction({ version: orig.version, lockTime: orig.lockTime, allowUnknownOutputs: true });
  for (const u of utxos) tx.addInput(inputFor(account, u));
  outputs.forEach((o, i) => {
    const amount = i === changeIdx ? newChange : o.amount;
    const extra = {};
    if (i === changeIdx && o.mine.path) {
      const der = { fingerprint: account.fingerprint >>> 0, path: o.mine.path };
      if (account.type === 'tr') Object.assign(extra, { tapInternalKey: o.mine.pubkey.slice(1), tapBip32Derivation: [[o.mine.pubkey.slice(1), { hashes: [], der }]] });
      else Object.assign(extra, { bip32Derivation: [[o.mine.pubkey, der]] }, o.mine.redeemScript ? { redeemScript: o.mine.redeemScript } : {});
    }
    tx.addOutput({ script: o.script, amount, ...extra });
  });
  return { psbt: tx.toPSBT(0), fee: newFee, oldFee, vsize };
}

/** Recent transactions with their effect on this wallet (most recent first). */
export async function loadHistory({ account, state, backend, loadPrevTx }, limit = 15) {
  const seen = new Map();
  const used = [...state.addrs.values()].filter((a) => a.used);
  const lists = await Promise.all(used.map((a) => backend.history(a)));
  for (const t of lists.flat()) if (!seen.has(t.txid) || seen.get(t.txid) === 0) seen.set(t.txid, t.height);
  // Unconfirmed first, then newest blocks first.
  const order = [...seen.entries()].sort((a, b) => (b[1] === 0) - (a[1] === 0) || b[1] - a[1]).slice(0, limit);
  const out = [];
  for (const [txid, height] of order) {
    const raw = await loadPrevTx(txid);
    const tx = btc.RawTx.decode(raw);
    let received = 0n;
    let spent = 0n;
    let allInputsMine = true;
    let rbf = false;
    for (const o of tx.outputs) if (state.addrs.has(hex.encode(o.script))) received += o.amount;
    let totalIn = 0n;
    for (const inp of tx.inputs) {
      if (inp.sequence < NO_RBF_SEQUENCE) rbf = true;
      const prevId = hex.encode(inp.txid);
      if (!seen.has(prevId)) {
        allInputsMine = false;
        continue;
      }
      const prev = btc.RawTx.decode(await loadPrevTx(prevId)).outputs[inp.index];
      if (prev && state.addrs.has(hex.encode(prev.script))) {
        spent += prev.amount;
        totalIn += prev.amount;
      } else allInputsMine = false;
    }
    const totalOut = tx.outputs.reduce((s, o) => s + o.amount, 0n);
    const hasChange = tx.outputs.some((o) => state.addrs.get(hex.encode(o.script))?.chain === 1 || (account.kind === 'single' && state.addrs.has(hex.encode(o.script))));
    out.push({
      txid,
      height,
      delta: received - spent,
      fee: allInputsMine ? totalIn - totalOut : undefined,
      canBump: account.net.coin === 'btc' && height === 0 && allInputsMine && hasChange,
      rbf,
    });
  }
  return out;
}
