// Local regtest chains for the integration and end-to-end tests:
//   Bitcoin Core + Fulcrum (BTC)  → ws://127.0.0.1:50103
//   Bitcoin Cash Node + Fulcrum   → ws://127.0.0.1:50203
// Tools are looked up in OEBW_REGTEST_TOOLS (default %LOCALAPPDATA%\overdoing-regtest).
// Usage: node scripts/regtest.mjs start | stop
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = process.env.OEBW_REGTEST_TOOLS ?? join(process.env.LOCALAPPDATA ?? '', 'overdoing-regtest');
const DATA = join(TOOLS, 'data');
const AUTH = { user: 'oebw', pass: 'oebw' };

export const CHAINS = {
  btc: { rpcPort: 18443, p2pPort: 18444, tcp: 50101, ws: 50103, exe: () => findExe('bitcoin-31', 'bitcoind.exe') },
  bch: { rpcPort: 18543, p2pPort: 18544, tcp: 50201, ws: 50203, exe: () => findExe('bitcoin-cash-node', 'bitcoind.exe') },
};
export const wsUrl = (coin) => `ws://127.0.0.1:${CHAINS[coin].ws}`;

function findExe(prefix, name) {
  for (const top of readdirSync(TOOLS).filter((d) => d.startsWith(prefix) && !d.endsWith('.zip'))) {
    for (const inner of readdirSync(join(TOOLS, top))) {
      const p = join(TOOLS, top, inner, 'bin', name);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(`${name} for ${prefix} not found under ${TOOLS}`);
}
const fulcrumExe = () => {
  const top = readdirSync(TOOLS).find((d) => d.startsWith('Fulcrum') && !d.endsWith('.zip'));
  const p = join(TOOLS, top, top, 'Fulcrum.exe');
  if (!existsSync(p)) throw new Error('Fulcrum.exe not found');
  return p;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rpc(coin, method, params = [], wallet) {
  const url = `http://127.0.0.1:${CHAINS[coin].rpcPort}/${wallet ? `wallet/${wallet}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${coin} ${method}: ${json.error.message}`);
  return json.result;
}

async function waitFor(fn, what, ms = 90_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}: ${last?.message ?? ''}`);
}

/** One Electrum call over WebSocket (for readiness checks). */
export function electrumCall(coin, method, params = []) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(coin));
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timeout'));
    }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    ws.onmessage = (m) => {
      clearTimeout(timer);
      ws.close();
      const r = JSON.parse(String(m.data));
      r.error ? reject(new Error(r.error.message)) : resolve(r.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    };
  });
}

const procs = [];
function launch(exe, args, logName) {
  const p = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
  p.on('exit', (code) => {
    if (code) console.error(`${logName} exited with ${code}: ${err}`);
  });
  procs.push(p);
  return p;
}

async function startChain(coin) {
  const c = CHAINS[coin];
  const dir = join(DATA, coin);
  mkdirSync(dir, { recursive: true });
  launch(
    c.exe(),
    [
      '-regtest', `-datadir=${dir}`, '-server', `-rpcuser=${AUTH.user}`, `-rpcpassword=${AUTH.pass}`,
      `-rpcport=${c.rpcPort}`, `-port=${c.p2pPort}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1',
      '-listen=0', '-dnsseed=0', '-discover=0', '-fallbackfee=0.0002', '-printtoconsole=0', '-txindex=1',
    ],
    `${coin} node`,
  );
  await waitFor(() => rpc(coin, 'getblockchaininfo'), `${coin} node`);
  await rpc(coin, 'createwallet', ['miner']).catch(() => rpc(coin, 'loadwallet', ['miner']).catch(() => {}));
  const addr = await rpc(coin, 'getnewaddress', [], 'miner');
  await rpc(coin, 'generatetoaddress', [101, addr], 'miner');

  const fdir = join(DATA, `fulcrum-${coin}`);
  mkdirSync(fdir, { recursive: true });
  const conf = join(DATA, `fulcrum-${coin}.conf`);
  writeFileSync(
    conf,
    [
      `datadir = ${fdir}`,
      `bitcoind = 127.0.0.1:${c.rpcPort}`,
      `rpcuser = ${AUTH.user}`,
      `rpcpassword = ${AUTH.pass}`,
      `tcp = 127.0.0.1:${c.tcp}`,
      `ws = 127.0.0.1:${c.ws}`,
      'peering = false',
      'announce = false',
      'polltime = 0.5',
      '',
    ].join('\n'),
  );
  launch(fulcrumExe(), [conf], `${coin} fulcrum`);
  await waitFor(async () => (await electrumCall(coin, 'blockchain.headers.subscribe')).height >= 101, `${coin} fulcrum sync`, 120_000);
}

export async function startRegtest() {
  rmSync(DATA, { recursive: true, force: true });
  await Promise.all([startChain('btc'), startChain('bch')]);
}

export async function stopRegtest() {
  await Promise.allSettled(['btc', 'bch'].map((coin) => rpc(coin, 'stop')));
  await sleep(1500);
  for (const p of procs) {
    try {
      p.kill();
    } catch {}
  }
}

/** Mines blocks and waits until Fulcrum has indexed them. */
export async function mine(coin, n = 1) {
  const addr = await rpc(coin, 'getnewaddress', [], 'miner');
  await rpc(coin, 'generatetoaddress', [n, addr], 'miner');
  const height = await rpc(coin, 'getblockcount');
  await waitFor(async () => (await electrumCall(coin, 'blockchain.headers.subscribe')).height >= height, 'fulcrum catch-up', 30_000);
}

/** Sends coins from the miner wallet and waits until Fulcrum sees the transaction. */
export async function fund(coin, address, amount) {
  const txid = await rpc(coin, 'sendtoaddress', [address, amount], 'miner');
  await waitFor(async () => (await electrumCall(coin, 'blockchain.transaction.get', [txid, false])) !== undefined, 'fulcrum mempool', 30_000);
  return txid;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'start') {
    await startRegtest();
    console.log(`regtest up: BTC ${wsUrl('btc')}  BCH ${wsUrl('bch')} (Ctrl-C to stop)`);
    process.on('SIGINT', async () => {
      await stopRegtest();
      process.exit(0);
    });
    await new Promise(() => {});
  } else {
    console.log('usage: node scripts/regtest.mjs start');
  }
}
