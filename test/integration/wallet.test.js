import { describe, expect, it } from 'vitest';
import { getNetwork } from '../../src/core/networks.js';
import { accountPath, deriveAddress, hdAccountFromRoot, privateKeyFor, rootFromMnemonic } from '../../src/core/keys.js';
import { signMessage, verifyMessage } from '../../src/core/message.js';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseRecipient } from '../../src/core/address.js';
import { createBackend } from '../../src/core/backend.js';
import { loadHistory, prepareBump, prepareTransfer, prevTxLoader, scanAccount } from '../../src/core/wallet.js';
import { finalizeBtcPsbt, reviewBtcPsbt, signBtcPsbt } from '../../src/core/btc.js';
import { describeBchPsbt, finalizeBchPsbt, signBchPsbt } from '../../src/core/bch.js';
import { makeIsMine, makeKeyFor } from '../../src/core/ownership.js';
import { formatCoins, parseCoins } from '../../src/core/amount.js';
import { fund, mine, rpc, wsUrl } from '../../scripts/regtest.mjs';

const base58check = createBase58check(sha256);
const PHRASE = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

function walletFor(coin, type) {
  const net = getNetwork(coin === 'btc' ? 'btc-regtest' : 'bch-regtest');
  const account = hdAccountFromRoot(rootFromMnemonic(PHRASE, '', net), net, type, accountPath(net, type, 0));
  const backend = createBackend(wsUrl(coin), net);
  return { net, account, backend, loadPrevTx: prevTxLoader(backend) };
}

/** Review → sign → finalize, the same way the signer UI does it. */
function signAndFinalize(w, psbt) {
  if (w.net.coin === 'bch') {
    describeBchPsbt(psbt);
    const isMine = makeIsMine(w.account);
    const { psbt: signed } = signBchPsbt(psbt, (inp) => {
      const mine = isMine(inp.script, inp.derivations);
      return mine ? makeKeyFor(w.account)({ mine }) : undefined;
    });
    return finalizeBchPsbt(signed);
  }
  const review = reviewBtcPsbt(psbt, w.net, makeIsMine(w.account));
  expect(review.inputs.every((i) => i.mine && i.verified)).toBe(true);
  return finalizeBtcPsbt(signBtcPsbt(psbt, review, makeKeyFor(w.account)).psbt);
}

async function sendAndCheck(w, coin, built) {
  const final = signAndFinalize(w, built.psbt);
  const [accept] = await rpc(coin, 'testmempoolaccept', [[final.hex]]);
  expect(accept.allowed, accept['reject-reason']).toBe(true);
  expect(await w.backend.broadcast(final.hex)).toBe(final.txid);
  return final;
}

const CASES = [
  ['btc', 'wpkh'],
  ['btc', 'tr'],
  ['btc', 'sh-wpkh'],
  ['btc', 'pkh'],
  ['bch', 'pkh'],
];

describe.each(CASES)('%s %s against a regtest node', (coin, type) => {
  it('discovers funds (including past a gap), sends with change, and sends "max"', async () => {
    const w = walletFor(coin, type);
    const empty = await scanAccount(w.account, w.backend);
    expect(empty.balance.confirmed).toBe(0n);
    expect(empty.receive.index).toBe(0);

    await fund(coin, deriveAddress(w.account, 0, 0).address, 0.5);
    await fund(coin, deriveAddress(w.account, 0, 0).address, 0.25);
    await fund(coin, deriveAddress(w.account, 0, 12).address, 0.1); // inside the 20-address gap
    await mine(coin);
    const funded = await scanAccount(w.account, w.backend);
    expect(funded.balance.confirmed).toBe(parseCoins('0.85'));
    expect(funded.utxos).toHaveLength(3);
    expect(funded.receive.index).toBe(13);

    const external = parseRecipient(w.net, await rpc(coin, 'getnewaddress', [], 'miner'));
    const ctx = { ...w, state: funded };
    const sent = await sendAndCheck(w, coin, await prepareTransfer(ctx, { to: external, amount: parseCoins('0.6'), feeRate: 2 }));
    await mine(coin);
    const after = await scanAccount(w.account, w.backend);
    expect(after.balance.confirmed).toBe(parseCoins('0.25') - sent.fee);
    expect(after.change.index).toBe(1); // the change went to m/…/1/0

    await sendAndCheck(w, coin, await prepareTransfer({ ...w, state: after }, { to: external, max: true, feeRate: 1 }));
    await mine(coin);
    const drained = await scanAccount(w.account, w.backend);
    expect(drained.balance.confirmed + drained.balance.unconfirmed).toBe(0n);
    expect(formatCoins(drained.balance.confirmed)).toBe('0');
    w.backend.close();
  });
});

describe('signed messages agree with the nodes', () => {
  it.each([['btc'], ['bch']])('%s: Bitcoin Core / BCHN verify ours, and we verify theirs', async (coin) => {
    const w = walletFor(coin, 'pkh');
    const a = deriveAddress(w.account, 0, 2);
    const key = privateKeyFor(w.account, a.path);
    const message = 'Overdoing 簽名測試 ✓';
    const ours = signMessage(key, message, 'pkh', w.net);
    expect(await rpc(coin, 'verifymessage', [a.address, ours, message])).toBe(true);
    const wif = base58check.encode(Uint8Array.from([0xef, ...key, 0x01]));
    const theirs = await rpc(coin, 'signmessagewithprivkey', [wif, message]);
    expect(verifyMessage(w.net, a.address, message, theirs)).toBe(true);
    w.backend.close();
  });
});

describe('replace-by-fee on Bitcoin', () => {
  it('bumps a stuck payment from the change output', async () => {
    const w = walletFor('btc', 'wpkh');
    const acc = { ...w, account: hdAccountFromRoot(rootFromMnemonic(PHRASE, '', w.net), w.net, 'wpkh', "m/84'/1'/5'") };
    await fund('btc', deriveAddress(acc.account, 0, 0).address, 0.3);
    await mine('btc');
    const state = await scanAccount(acc.account, w.backend);
    const external = parseRecipient(w.net, await rpc('btc', 'getnewaddress', [], 'miner'));
    const first = await sendAndCheck(acc, 'btc', await prepareTransfer({ ...acc, state }, { to: external, amount: parseCoins('0.1'), feeRate: 1 }));

    // Fulcrum polls the node's mempool; wait until it has indexed the payment.
    let pending;
    let history = [];
    for (let i = 0; i < 40 && history[0]?.txid !== first.txid; i++) {
      await new Promise((r) => setTimeout(r, 250));
      pending = await scanAccount(acc.account, w.backend);
      history = await loadHistory({ ...acc, state: pending });
    }
    expect(history[0]).toMatchObject({ txid: first.txid, height: 0, canBump: true, rbf: true });
    expect(history[0].delta).toBe(-(parseCoins('0.1') + history[0].fee));

    const bump = await prepareBump({ ...acc, state: pending }, { txid: first.txid, feeRate: 6 });
    expect(bump.fee).toBeGreaterThan(bump.oldFee);
    const replacement = await sendAndCheck(acc, 'btc', bump);
    const mempool = await rpc('btc', 'getrawmempool');
    expect(mempool).toContain(replacement.txid);
    expect(mempool).not.toContain(first.txid);
    await mine('btc');
    const done = await scanAccount(acc.account, w.backend);
    expect(done.balance.confirmed).toBe(parseCoins('0.2') - bump.fee);
    w.backend.close();
  });
});
