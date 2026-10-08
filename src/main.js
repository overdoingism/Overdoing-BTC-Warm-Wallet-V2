import { NETWORKS, SCRIPT_TYPES, defaultType, explorerTxUrl, getNetwork, typesFor } from './core/networks.js';
import {
  accountPath,
  canSign,
  deriveAddress,
  displayXpub,
  formatDescriptor,
  formatPath,
  hdAccountFromRoot,
  hdAccountFromXpub,
  inspectMnemonic,
  parseDescriptor,
  parsePath,
  parseWif,
  parseXpub,
  rootFromMnemonic,
  singleAccountFromAddress,
  singleAccountFromWif,
} from './core/keys.js';
import { parseRecipient, scriptToAddress } from './core/address.js';
import { createBackend } from './core/backend.js';
import { loadHistory, prepareBump, prepareTransfer, prevTxLoader, scanAccount } from './core/wallet.js';
import { describeRawTx, finalizeBtcPsbt, reviewBtcPsbt, signBtcPsbt } from './core/btc.js';
import { BCH_DUST, describeBchPsbt, estimateSize, finalizeBchPsbt, signBchPsbt } from './core/bch.js';
import { makeIsMine, makeKeyFor } from './core/ownership.js';
import { formatCoins, parseCoins, parseFeeRate, parseInteger } from './core/amount.js';
import { signMessage, verifyMessage } from './core/message.js';
import { createVault } from './core/vault.js';
import { classify, encodeMessageRequest, formatSignedMessage } from './core/payload.js';
import { URDecoder, UREncoder } from './core/ur.js';
import { ACCOUNT_UR_TYPES, BCH_PSBT_TYPE, PSBT_TYPES, accountToCbor, accountsFromUR, cborToPsbt, psbtToCbor } from './core/urtypes.js';
import { WalletError } from './core/errors.js';
import { applyI18n, getLang, initLang, setLang, t } from './i18n.js';
import { decodeImageFile, playUR, qrDataUrl, startScanner } from './ui/qr.js';
import { $, bullet, copyText, para, radio, setRadio, show, toast, val } from './ui/dom.js';
import { action, alertError, confirmDialog, errorText, fillRows, initDialogs, openDialog, passwordDialog, withBusy } from './ui/dialogs.js';
import { base64, hex } from '@scure/base';

// ---------------------------------------------------------------- storage (non-secret preferences)
const safeStorage = (() => {
  try {
    const s = window.localStorage;
    s.getItem('oebw.probe');
    return s;
  } catch {
    const fail = () => {
      throw new Error('storage unavailable');
    };
    return { getItem: fail, setItem: fail };
  }
})();
const store = {
  get(key, fallback) {
    try {
      const v = safeStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      safeStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode: preferences are simply not remembered
    }
  },
};
const vault = createVault(safeStorage);

// ---------------------------------------------------------------- state
const state = {
  net: getNetwork('btc'),
  account: null, // keys.js account + { source, mnemonic?, passphrase? }
  wallet: null, // scanAccount() result
  backend: null,
  backendUrl: '',
  loadPrevTx: null,
  history: [],
  syncedAt: null,
  sendMax: false,
  result: null,
  resultPlayer: null,
  qrPlayer: null,
};

const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const short = (s, n = 10) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s ?? '');
const coins = (sats) => `${formatCoins(sats)} ${state.net.symbol}`;
const feeUnit = () => (state.net.coin === 'bch' ? 'sat/B' : 'sat/vB');
const locale = () => (getLang() === 'en' ? 'en' : 'zh-TW');
const fpHex = (fp) => (fp >>> 0).toString(16).padStart(8, '0');
const ctx = () => ({ account: state.account, state: state.wallet, backend: state.backend, loadPrevTx: state.loadPrevTx });

function requireAccount() {
  if (!state.account) throw new WalletError('err.noAccount');
  return state.account;
}

// ---------------------------------------------------------------- network & server
function renderNetSelect() {
  const coin = radio('coin');
  const nets = NETWORKS.filter((n) => n.coin === coin);
  $('netSel').replaceChildren(...nets.map((n) => new Option(n.name, n.id)));
  $('netSel').value = state.net.coin === coin ? state.net.id : nets[0].id;
}

function serverFor(net) {
  return store.get('oebw.servers', {})[net.id] || net.servers[0] || '';
}

function applyNetwork(net) {
  state.net = net;
  setRadio('coin', net.coin);
  renderNetSelect();
  $('serverUrl').value = serverFor(net);
  $('serverList').replaceChildren(...net.servers.map((u) => new Option(u, u)));
  $('brandCoin').textContent = net.coin === 'bch' ? 'BCH' : 'BTC';
  $('amountUnit').textContent = net.symbol;
  $('feeUnit').textContent = feeUnit();
  $('typeSel').replaceChildren(...typesFor(net).map((type) => new Option(t(`type.${type}`), type)));
  $('typeSel').value = defaultType(net);
  show('rbfRow', net.coin === 'btc');
  store.set('oebw.net', net.id);
  resetBackend();
  updateKeyOpts();
  updateToHint();
}

async function onNetworkChange(id) {
  const net = getNetwork(id);
  if (state.account && net.id !== state.net.id) {
    const ok = await confirmDialog({ title: t('net.switchTitle'), warnings: [{ text: t('net.switchBody') }], ok: t('net.switch') });
    if (!ok) {
      setRadio('coin', state.net.coin);
      renderNetSelect();
      return;
    }
    logout();
  }
  applyNetwork(net);
}

function onServerChange() {
  const map = store.get('oebw.servers', {});
  const v = val('serverUrl');
  if (!v || v === state.net.servers[0]) delete map[state.net.id];
  else map[state.net.id] = v;
  store.set('oebw.servers', map);
  resetBackend();
}

function resetBackend() {
  state.backend?.close();
  state.backend = null;
  state.backendUrl = '';
  state.loadPrevTx = null;
}

function backend() {
  const url = val('serverUrl');
  if (!url) throw new WalletError('err.noServer');
  if (!state.backend || state.backendUrl !== url) {
    state.backend?.close();
    state.backend = createBackend(url, state.net);
    state.backendUrl = url;
    state.loadPrevTx = prevTxLoader(state.backend);
  }
  return state.backend;
}

// ---------------------------------------------------------------- account input
function classifyKey(text) {
  const s = text.trim();
  if (!s) return 'empty';
  if (/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s)) return 'wif';
  if (/[()]/.test(s)) return 'descriptor';
  if (/^[xyztuv]pub[1-9A-HJ-NP-Za-km-z]{100,}$/.test(s)) return 'xpub';
  try {
    parseRecipient(state.net, s);
    return 'address';
  } catch {
    return 'mnemonic';
  }
}

function updateKeyOpts() {
  const kind = classifyKey($('keyInput').value);
  const xpub = kind === 'xpub' ? parseXpub($('keyInput').value) : null;
  const needType = kind === 'mnemonic' || kind === 'wif' || (kind === 'xpub' && xpub && !xpub.impliedType);
  show('keyOpts', needType || kind === 'xpub');
  show('typeRow', needType && typesFor(state.net).length > 1);
  show('accountRow', kind === 'mnemonic' || kind === 'xpub');
  show('passRow', kind === 'mnemonic');
  show('pathRow', kind === 'mnemonic');
}

async function loadFromInput() {
  const text = $('keyInput').value.trim();
  const net = state.net;
  const type = typesFor(net).includes($('typeSel').value) ? $('typeSel').value : defaultType(net);
  switch (classifyKey(text)) {
    case 'empty':
      throw new WalletError('err.inputEmpty');
    case 'wif': {
      const k = parseWif(text);
      if (!k) throw new WalletError('err.privateKey');
      if (k.testnet !== net.testnet) throw new WalletError('err.keyNetwork');
      return setAccount({ ...singleAccountFromWif(k.privateKey, net, type), source: 'wif' });
    }
    case 'descriptor': {
      const d = parseDescriptor(text);
      if (!d) throw new WalletError('err.descUnsupported');
      return loadXpubAccount(d.node, d.testnet, d.type, d.fingerprint, d.path);
    }
    case 'xpub': {
      const x = parseXpub(text);
      if (!x) throw new WalletError('err.xpub');
      const index = parseInteger(val('accountIndex') || '0', 'accountIndex', { max: 0x7fffffff });
      const t2 = x.impliedType ?? type;
      return loadXpubAccount(x.node, x.testnet, t2, 0, parsePath(accountPath(net, t2, index)));
    }
    case 'address': {
      const r = parseRecipient(net, text);
      const kindType = { pkh: 'pkh', wpkh: 'wpkh', sh: 'sh-wpkh', tr: 'tr' }[r.kind];
      if (!kindType) throw new WalletError('err.addressType');
      return setAccount({ ...singleAccountFromAddress(net, kindType, r.address, r.script), source: 'address' });
    }
    default:
      return loadMnemonic(text, type);
  }
}

function loadXpubAccount(node, testnet, type, fingerprint, path) {
  const net = state.net;
  if (testnet !== net.testnet) throw new WalletError('err.keyNetwork');
  if (!type || !typesFor(net).includes(type)) throw new WalletError('err.scriptType');
  const acc = hdAccountFromXpub(node, net, type, fingerprint, path ?? parsePath(accountPath(net, type, 0)));
  setAccount({ ...acc, source: 'xpub' });
}

async function loadMnemonic(text, type) {
  const m = inspectMnemonic(text);
  if (m.status === 'badLength') throw new WalletError('err.mnemonicLength', { n: m.wordCount });
  if (m.status !== 'ok') {
    const warning = m.status === 'badChecksum' ? t('mn.badChecksum') : t('mn.unknownWords', { words: m.unknownWords.slice(0, 6).join(', ') });
    const go = await confirmDialog({ title: t('mn.title'), warnings: [{ text: warning, danger: true }, { text: t('mn.explain') }], ok: t('mn.useAnyway') });
    if (!go) return;
  }
  const net = state.net;
  const index = parseInteger(val('accountIndex') || '0', 'accountIndex', { max: 0x7fffffff });
  const path = val('customPath') || accountPath(net, type, index);
  const passphrase = $('passphrase').value;
  const root = rootFromMnemonic(m.phrase, passphrase, net);
  setAccount({ ...hdAccountFromRoot(root, net, type, path), source: 'mnemonic', mnemonic: m.phrase, passphrase });
}

function setAccount(acc) {
  state.account = acc;
  state.wallet = null;
  state.history = [];
  state.syncedAt = null;
  $('keyInput').value = '';
  $('passphrase').value = '';
  $('customPath').value = '';
  show('acctInput', false);
  show('acctView', true);
  clearResult();
  renderAccount();
  renderBalance();
  renderUtxos();
  renderHistory();
  renderMsgAddrs();
  updateToHint();
}

function logout() {
  state.account = null;
  state.wallet = null;
  state.history = [];
  show('acctInput', true);
  show('acctView', false);
  clearResult();
  renderAccount();
  renderUtxos();
  renderHistory();
  renderMsgAddrs();
}

function renderAccount() {
  const acc = state.account;
  const signer = canSign(acc);
  if (acc) {
    $('acctBadge').textContent = t(signer ? 'acct.signer' : 'acct.watch');
    $('acctBadge').className = `badge ${signer ? 'signer' : 'watch'}`;
    $('acctType').textContent = t(`type.${acc.type}`);
    $('acctOrigin').textContent = acc.kind === 'hd' ? `[${fpHex(acc.fingerprint)}${formatPath(acc.path).slice(1)}] ${short(displayXpub(acc), 12)}` : acc.address;
  }
  show('btnSaveVault', acc?.source === 'mnemonic');
  show('offlineHint', signer && !state.wallet);
  $('btnSend').textContent = acc && !signer ? t('send.makeRequest') : t('send.sign');
  $('btnSignMsg').textContent = acc && !signer ? t('msg.makeRequest') : t('msg.sign');
}

function renderBalance() {
  const w = state.wallet;
  show('balanceBox', !!w);
  show('tokenNote', !!w?.tokenUtxos);
  if (!w) return;
  const pending = w.balance.unconfirmed ? ` (${w.balance.unconfirmed > 0n ? '+' : ''}${formatCoins(w.balance.unconfirmed)} ${t('acct.unconfirmed')})` : '';
  $('balConfirmed').textContent = coins(w.balance.confirmed) + pending;
  $('balUtxos').textContent = String(w.utxos.length);
  $('balSynced').textContent = `${state.syncedAt.toLocaleTimeString(locale())} · #${w.tip}`;
  $('tokenNote').textContent = t('acct.tokenUtxos', { n: w.tokenUtxos });
  show('offlineHint', false);
}

// ---------------------------------------------------------------- sync, receive, export
async function sync() {
  const acc = requireAccount();
  const be = backend();
  const w = await withBusy(t('busy.sync'), () => scanAccount(acc, be));
  state.wallet = w;
  state.syncedAt = new Date();
  renderBalance();
  renderFeeChips();
  renderUtxos();
  renderMsgAddrs();
  renderAccount();
  if (!val('feeRate') && w.fees) $('feeRate').value = String(w.fees.normal);
  state.history = await loadHistory(ctx()).catch(() => []);
  renderHistory();
}

function showQr({ title, hint, text, ur, alt }) {
  stopPlayer('qrPlayer');
  $('qrTitle').textContent = title;
  $('qrHint').textContent = hint ?? '';
  $('qrText').textContent = text;
  if (ur) {
    state.qrPlayer = playUR($('qrImg'), urEncoder(ur));
    $('qrInfo').textContent = state.qrPlayer.parts > 1 ? t('qr.animated', { n: state.qrPlayer.parts }) : '';
  } else {
    $('qrImg').src = qrDataUrl(text);
    $('qrInfo').textContent = '';
  }
  $('btnQrCopy').onclick = () => copyText(text);
  show('btnQrAlt', !!alt);
  if (alt) {
    $('btnQrAlt').textContent = alt.label;
    $('btnQrAlt').onclick = () => showQr(alt.view);
  }
  if (!$('dlgQr').open) openDialog($('dlgQr')).then(() => stopPlayer('qrPlayer'));
}

function showReceive() {
  const acc = requireAccount();
  const a = state.wallet?.receive ?? deriveAddress(acc, 0, 0);
  const where = a.path ? formatPath(a.path) : '';
  showQr({ title: t('acct.receive'), text: a.address, hint: (state.wallet ? '' : t('recv.notSynced') + ' ') + t('recv.hint', { path: where }) });
}

function exportAccount() {
  const acc = requireAccount();
  if (acc.kind !== 'hd') return showQr({ title: t('acct.export'), text: acc.address, hint: t('exp.single') });
  const descriptor = formatDescriptor(acc);
  const urView = { title: t('acct.export'), text: descriptor, hint: t('exp.urHint'), ur: { type: 'crypto-account', cbor: accountToCbor(acc), fragment: 400 } };
  const textView = { title: t('acct.export'), text: descriptor, hint: t('exp.textHint') };
  urView.alt = { label: t('exp.showText'), view: textView };
  textView.alt = { label: t('exp.showUr'), view: urView };
  showQr(urView);
}

// ---------------------------------------------------------------- vault
async function saveToVault() {
  const acc = requireAccount();
  const intro = [para(t('vault.riskIntro')), bullet([t('vault.risk1'), t('vault.risk2'), t('vault.risk3'), t('vault.risk4')])];
  if (acc.passphrase) intro.push(para(t('vault.passNote')));
  const r = await passwordDialog({ title: t('vault.saveTitle'), intro, confirm: true, name: '', ack: true, minLength: 8 });
  if (!r) return;
  const secret = {
    mnemonic: acc.mnemonic,
    hasPassphrase: !!acc.passphrase,
    fingerprint: acc.fingerprint,
    netId: acc.net.id,
    type: acc.type,
    path: formatPath(acc.path),
  };
  await withBusy(t('busy.encrypt'), (onProgress) => vault.add(r.name || t(`type.${acc.type}`), secret, r.password, { onProgress }));
  toast(t('vault.saved'));
}

function renderVaultList() {
  const entries = vault.list();
  show('vaultEmpty', entries.length === 0);
  $('vaultList').replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = e.name;
      const when = document.createElement('span');
      when.className = 'hint';
      when.textContent = t('vault.created', { date: new Date(e.created).toLocaleString(locale()) });
      const row = document.createElement('div');
      row.className = 'row';
      const open = document.createElement('button');
      open.className = 'btn small primary';
      open.type = 'button';
      open.textContent = t('vault.open');
      open.onclick = () => unlockVaultEntry(e).catch(alertError);
      const del = document.createElement('button');
      del.className = 'btn small';
      del.type = 'button';
      del.textContent = t('vault.delete');
      del.onclick = () => deleteVaultEntry(e).catch(alertError);
      row.append(open, del);
      li.append(name, when, row);
      return li;
    }),
  );
}

async function unlockVaultEntry(e) {
  $('dlgVault').close();
  const r = await passwordDialog({ title: t('vault.unlockTitle', { name: e.name }) });
  if (!r) return;
  const secret = await withBusy(t('busy.decrypt'), (onProgress) => vault.unlock(e.id, r.password, { onProgress }));
  let passphrase = '';
  if (secret.hasPassphrase) {
    const p = await passwordDialog({ title: t('vault.passTitle'), intro: [para(t('vault.passPrompt'))] });
    if (!p) return;
    passphrase = p.password;
  }
  const net = getNetwork(secret.netId) ?? state.net;
  if (net.id !== state.net.id) applyNetwork(net);
  const root = rootFromMnemonic(secret.mnemonic, passphrase, net);
  if (secret.fingerprint && root.fingerprint !== secret.fingerprint) throw new WalletError('err.passphraseMismatch');
  setAccount({ ...hdAccountFromRoot(root, net, secret.type, secret.path), source: 'mnemonic', mnemonic: secret.mnemonic, passphrase });
}

async function deleteVaultEntry(e) {
  $('dlgVault').close();
  const ok = await confirmDialog({ title: t('vault.deleteTitle'), rows: [[t('pw.name'), e.name]], warnings: [{ text: t('vault.deleteWarn'), danger: true }], ok: t('vault.delete') });
  if (!ok) return;
  vault.remove(e.id);
  toast(t('vault.deleted'));
}

// ---------------------------------------------------------------- send form
function updateToHint() {
  const el = $('toHint');
  const text = val('toAddr');
  if (!text) {
    el.textContent = '';
    return;
  }
  try {
    const r = parseRecipient(state.net, text);
    let msg = t('to.ok', { kind: t(`kind.${r.kind}`) });
    if (r.converted) msg += ` ${t('to.converted', { address: r.address })}`;
    if (r.tokenAware) msg += ` ${t('to.tokenAware')}`;
    if (state.wallet?.addrs.has(hex.encode(r.script))) msg += ` ${t('to.self')}`;
    el.textContent = msg;
    el.className = 'hint ok';
  } catch (e) {
    el.textContent = errorText(e);
    el.className = 'hint bad';
  }
}

function setMax(on) {
  state.sendMax = on;
  $('amount').disabled = on;
  $('amount').value = on ? '' : $('amount').value;
  $('amount').placeholder = on ? t('send.maxPlaceholder') : '';
  $('btnMax').textContent = t(on ? 'send.maxCancel' : 'send.max');
  show('maxNote', on);
  $('maxNote').textContent = t('send.maxNote');
}

function renderFeeChips() {
  const fees = state.wallet?.fees;
  $('feeChips').replaceChildren(
    ...(fees
      ? ['fast', 'normal', 'slow'].map((k) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip';
          b.textContent = `${t(`fee.${k}`)} ${fees[k]}`;
          b.onclick = () => {
            $('feeRate').value = String(fees[k]);
          };
          return b;
        })
      : []),
  );
}

function renderUtxos() {
  const w = state.wallet;
  const list = $('utxoList');
  list.replaceChildren();
  if (!w) return;
  for (const u of w.utxos) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = u.key;
    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent = formatCoins(u.value);
    const meta = document.createElement('span');
    meta.className = 'meta';
    const conf = u.height ? t('utxo.conf', { n: w.tip - u.height + 1 }) : t('utxo.unconfirmed');
    meta.textContent = `${short(u.address, 8)} · ${conf} · ${short(u.txid, 6)}:${u.vout}`;
    label.append(cb, amt, meta);
    li.append(label);
    list.append(li);
  }
}

const selectedUtxos = () => [...document.querySelectorAll('#utxoList input:checked')].map((c) => c.value);

async function onSend() {
  const acc = requireAccount();
  if (!state.wallet) throw new WalletError(canSign(acc) ? 'err.needSyncSigner' : 'err.needSync');
  const to = parseRecipient(state.net, val('toAddr'));
  const amount = state.sendMax ? undefined : parseCoins(val('amount'));
  const feeRate = parseFeeRate(val('feeRate'));
  const built = await withBusy(t('busy.build'), () =>
    prepareTransfer(ctx(), { to, amount, max: state.sendMax, feeRate, rbf: $('rbf').checked, selectedKeys: selectedUtxos() }),
  );
  await reviewAndAct(built.psbt, { local: true, recipient: to });
}

// ---------------------------------------------------------------- review, sign, finalize
/** Uniform review of a BTC or BCH PSBT for the loaded account. */
function reviewPsbt(psbt) {
  const acc = state.account;
  const isMine = acc ? makeIsMine(acc) : () => null;
  if (state.net.coin === 'btc') return reviewBtcPsbt(psbt, state.net, isMine);
  const v = describeBchPsbt(psbt);
  const inputs = v.inputs.map((i) => ({ ...i, kind: 'pkh', verified: true, address: scriptToAddress(state.net, i.script), mine: isMine(i.script, i.derivations) }));
  const outputs = v.outputs.map((o) => {
    const mine = o.derivations.length ? isMine(o.script, o.derivations) : null;
    return { ...o, address: scriptToAddress(state.net, o.script), change: !!mine, mine };
  });
  const totalIn = inputs.reduce((s, i) => s + i.amount, 0n);
  const totalOut = outputs.reduce((s, o) => s + o.amount, 0n);
  return { inputs, outputs, totalIn, totalOut, fee: totalIn - totalOut, vsize: estimateSize(inputs.length, outputs.map((o) => o.script)), rbf: false, lockTime: v.lockTime };
}

function reviewRows(r) {
  const rows = [[t('rv.network'), state.net.name]];
  for (const o of r.outputs.filter((x) => !x.change)) rows.push([t('rv.pay'), `${coins(o.amount)} → ${o.address || t('rv.unknownScript')}`]);
  for (const o of r.outputs.filter((x) => x.change)) rows.push([t('rv.change'), `${coins(o.amount)} → ${o.address} (${t('rv.verifiedMine')} ${formatPath(o.mine.path ?? []) || ''})`]);
  rows.push([t('rv.inputs'), t('rv.inputsValue', { n: r.inputs.length, total: r.fee === undefined ? '?' : coins(r.totalIn) })]);
  if (r.fee !== undefined) rows.push([t('rv.fee'), `${coins(r.fee)} (${r.fee} sat, ≈ ${(Number(r.fee) / r.vsize).toFixed(1)} ${feeUnit()})`]);
  if (state.net.coin === 'btc') rows.push(['RBF', t(r.rbf ? 'rv.yes' : 'rv.no')]);
  return rows;
}

function reviewWarnings(r) {
  const w = [];
  const foreign = r.inputs.filter((i) => !i.mine).length;
  if (foreign) w.push({ text: t('warn.foreignInputs', { n: foreign }) });
  if (r.inputs.some((i) => i.mine && !i.verified)) w.push({ text: t('warn.unverified'), danger: true });
  const external = r.outputs.filter((o) => !o.change);
  if (!external.length) w.push({ text: t('warn.consolidate') });
  if (r.outputs.some((o) => !o.address)) w.push({ text: t('warn.unknownScript'), danger: true });
  if (r.outputs.some((o) => o.amount < BCH_DUST && o.amount > 0n)) w.push({ text: t('warn.dust') });
  if (r.fee !== undefined) {
    const sent = external.reduce((s, o) => s + o.amount, 0n);
    const rate = Number(r.fee) / r.vsize;
    if (rate > 500 || (sent > 0n && r.fee * 10n > sent) || r.fee > 1_000_000n) w.push({ text: t('warn.highFee', { fee: coins(r.fee) }), danger: rate > 2000 || r.fee * 2n > sent });
  }
  return w;
}

async function reviewAndAct(psbt, { local }) {
  const acc = state.account;
  const r = reviewPsbt(psbt);
  const signer = canSign(acc);
  const toSign = signer && r.inputs.some((i) => i.mine && !i.signed);
  if (signer && !toSign && !r.inputs.every((i) => i.signed)) throw new WalletError('err.nothingToSign');
  const ok = await confirmDialog({
    title: t(toSign ? 'rv.titleSign' : local ? 'rv.titleRequest' : 'rv.titleView'),
    rows: reviewRows(r),
    warnings: reviewWarnings(r),
    ok: t(toSign ? 'btn.sign' : local ? 'btn.makeQr' : 'btn.continue'),
  });
  if (!ok) return;
  if (toSign) {
    const signed = signPsbt(psbt, r);
    const final = tryFinalize(signed);
    // Show the signed PSBT as an animated QR for the online device (or Sparrow & co.).
    // When this device is the online one too, it can broadcast directly.
    showResult({ kind: 'signed', psbt: signed, review: reviewPsbt(signed), final, canBroadcast: local && !!final });
  } else if (local) {
    showResult({ kind: 'unsigned', psbt, review: r });
  } else {
    const final = tryFinalize(psbt);
    if (!final) throw new WalletError('err.notFullySigned');
    showResult({ kind: 'final', raw: final.hex, txid: final.txid, review: r, final, canBroadcast: true });
  }
}

function signPsbt(psbt, review) {
  const acc = state.account;
  const keyFor = makeKeyFor(acc);
  if (state.net.coin === 'btc') {
    const out = signBtcPsbt(psbt, review, keyFor);
    if (!out.signed) throw new WalletError('err.nothingToSign');
    return out.psbt;
  }
  const isMine = makeIsMine(acc);
  const out = signBchPsbt(psbt, (inp) => {
    const mine = isMine(inp.script, inp.derivations);
    return mine ? keyFor({ mine }) : undefined;
  });
  if (!out.signed) throw new WalletError('err.nothingToSign');
  return out.psbt;
}

function tryFinalize(psbt) {
  try {
    return state.net.coin === 'btc' ? finalizeBtcPsbt(psbt) : finalizeBchPsbt(psbt);
  } catch (e) {
    if (e instanceof WalletError && e.key === 'err.notFullySigned') return null;
    throw e;
  }
}

// ---------------------------------------------------------------- results
function stopPlayer(key) {
  state[key]?.stop();
  state[key] = null;
}

function clearResult() {
  stopPlayer('resultPlayer');
  state.result = null;
  show('secResult', false);
}

function showResult(r) {
  state.result = r;
  renderResult();
  $('secResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Bytes per animated-QR frame: small enough for phone cameras at 300 px (about QR version 10).
const UR_FRAGMENT = 120;
const urEncoder = (ur) => new UREncoder(ur.type, ur.cbor, ur.fragment ?? UR_FRAGMENT);
const psbtUr = (psbt) => ({ type: state.net.coin === 'bch' ? BCH_PSBT_TYPE : 'crypto-psbt', cbor: psbtToCbor(psbt) });

function renderResult() {
  stopPlayer('resultPlayer');
  const r = state.result;
  if (!r) return show('secResult', false);
  let title;
  let hint = '';
  let text = '';
  let ur = null;
  let qrText = null;
  let rows = [];
  if (r.kind === 'unsigned' || r.kind === 'signed') {
    title = t(r.kind === 'unsigned' ? 'res.unsigned' : 'res.signed');
    hint = t(r.kind === 'unsigned' ? 'res.unsignedHint' : !r.final ? 'res.partialHint' : r.canBroadcast ? 'res.signedHintLocal' : 'res.signedHint');
    text = base64.encode(r.psbt);
    ur = psbtUr(r.psbt);
    rows = reviewRows(r.review);
    if (r.final) rows.push([t('rv.txid'), r.final.txid, 'mono']);
  } else if (r.kind === 'final') {
    title = t('res.final');
    text = r.raw;
    rows = r.review ? reviewRows(r.review) : r.rows ?? [];
    rows.push([t('rv.txid'), r.txid, 'mono']);
  } else if (r.kind === 'msgRequest') {
    title = t('res.msgRequest');
    hint = t('res.msgRequestHint');
    text = r.payload;
    qrText = r.payload;
    rows = [[t('msg.address'), r.address, 'mono'], [t('msg.message'), r.message, 'pre']];
  } else if (r.kind === 'signature') {
    title = t('res.signature');
    hint = t('res.signatureHint');
    text = r.armored;
    qrText = r.armored;
    rows = [[t('msg.address'), r.address, 'mono'], [t('msg.message'), r.message, 'pre'], [t('msg.signature'), r.signature, 'mono']];
  } else if (r.kind === 'verify') {
    title = t('res.verify');
    text = r.armored;
    rows = [
      [t('msg.result'), t(r.valid ? 'msg.valid' : 'msg.invalid'), r.valid ? 'good' : 'bad'],
      [t('msg.address'), r.address, 'mono'],
      [t('msg.message'), r.message, 'pre'],
    ];
  }
  $('resultTitle').textContent = title;
  show('resultQrBox', !!(ur || qrText));
  $('resultHint').textContent = hint;
  $('resultQrInfo').textContent = '';
  if (ur) {
    state.resultPlayer = playUR($('resultQr'), urEncoder(ur));
    if (state.resultPlayer.parts > 1) $('resultQrInfo').textContent = t('qr.animated', { n: state.resultPlayer.parts });
  } else if (qrText) {
    $('resultQr').src = qrDataUrl(qrText);
  }
  fillRows($('resultRows'), rows);
  $('resultText').value = text;
  show('btnBroadcast', !!r.canBroadcast);
  show('secResult', true);
  renderBroadcastStatus();
}

function renderBroadcastStatus() {
  const r = state.result;
  const el = $('bcastStatus');
  const s = r?.status;
  $('btnBroadcast').disabled = !!s && (s.state === 'sending' || s.state === 'sent');
  if (!s) return show(el, false);
  el.className = `status pre${s.state === 'sent' ? ' ok' : s.state === 'error' ? ' bad' : ''}`;
  el.replaceChildren(s.state === 'sending' ? t('bc.sending') : s.state === 'sent' ? t('bc.sent', { txid: s.txid }) : s.message);
  const url = s.state === 'sent' ? explorerTxUrl(state.net, s.txid) : '';
  if (url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = t('bc.explorer');
    el.append('\n', a);
  }
  show(el, true);
}

async function broadcast() {
  const r = state.result;
  const raw = r?.final?.hex ?? r?.raw;
  if (!raw) return;
  const be = backend();
  r.status = { state: 'sending' };
  renderBroadcastStatus();
  try {
    const txid = await be.broadcast(raw);
    r.status = { state: 'sent', txid };
    renderBroadcastStatus();
    if (state.account && state.wallet) setTimeout(() => sync().catch(() => {}), 1500);
  } catch (e) {
    r.status = { state: 'error', message: errorText(e) };
    renderBroadcastStatus();
  }
}

// ---------------------------------------------------------------- history & RBF
function renderHistory() {
  const list = $('historyList');
  list.replaceChildren();
  show('historyEmpty', !state.history.length);
  const tip = state.wallet?.tip ?? 0;
  for (const h of state.history) {
    const li = document.createElement('li');
    const amt = document.createElement('span');
    amt.className = `amt ${h.delta >= 0n ? 'in' : 'out'}`;
    amt.textContent = `${h.delta >= 0n ? '+' : ''}${formatCoins(h.delta)} ${state.net.symbol}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const conf = h.height ? t('utxo.conf', { n: tip - h.height + 1 }) : t('utxo.unconfirmed');
    const url = explorerTxUrl(state.net, h.txid);
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = short(h.txid, 8);
      meta.append(`${conf} · `, a);
    } else meta.textContent = `${conf} · ${short(h.txid, 8)}`;
    li.append(amt);
    if (h.canBump) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.type = 'button';
      b.textContent = t('hist.bump');
      b.onclick = () => bump(h).catch(alertError);
      li.append(b);
    }
    li.append(meta);
    list.append(li);
  }
}

async function bump(h) {
  const feeRate = parseFeeRate(val('feeRate') || String(state.wallet?.fees?.fast ?? ''));
  const built = await withBusy(t('busy.build'), () => prepareBump(ctx(), { txid: h.txid, feeRate }));
  await reviewAndAct(built.psbt, { local: true });
}

// ---------------------------------------------------------------- messages
function renderMsgAddrs() {
  const sel = $('msgAddr');
  const acc = state.account;
  sel.replaceChildren();
  if (!acc) return;
  const list = [];
  if (acc.kind === 'single') list.push(deriveAddress(acc, 0, 0));
  else {
    const used = state.wallet ? [...state.wallet.addrs.values()].filter((a) => a.used && a.chain === 0) : [];
    list.push(...used, state.wallet?.receive ?? deriveAddress(acc, 0, 0));
  }
  const seen = new Set();
  for (const a of list) {
    if (seen.has(a.address)) continue;
    seen.add(a.address);
    sel.append(new Option(a.path ? `${a.address} (${formatPath(a.path)})` : a.address, a.address));
  }
}

/** Our address info (with path) for an address string, searching the account if needed. */
function findOwnAddress(address) {
  const acc = requireAccount();
  const r = parseRecipient(state.net, address);
  if (acc.kind === 'single') return hex.encode(acc.script) === hex.encode(r.script) ? deriveAddress(acc, 0, 0) : null;
  const known = state.wallet?.addrs.get(hex.encode(r.script));
  if (known) return known;
  const mine = makeIsMine(acc)(r.script, []);
  return mine ? deriveAddress(acc, mine.chain, mine.index) : null;
}

async function signMessageFlow(address, message) {
  const acc = requireAccount();
  if (!message) throw new WalletError('err.messageEmpty');
  if (!address) throw new WalletError('err.noAddress');
  if (!canSign(acc)) {
    const payload = encodeMessageRequest({ address, message });
    showResult({ kind: 'msgRequest', payload, address, message });
    return;
  }
  const own = findOwnAddress(address);
  if (!own) throw new WalletError('err.notMyAddress', { address });
  const ok = await confirmDialog({ title: t('msg.confirmTitle'), rows: [[t('msg.address'), address, 'mono'], [t('msg.message'), message, 'pre']], ok: t('btn.sign') });
  if (!ok) return;
  const key = acc.kind === 'single' ? acc.privateKey : makeKeyFor(acc)({ mine: { path: own.path } });
  const signature = signMessage(key, message, acc.type, state.net);
  showResult({ kind: 'signature', address, message, signature, armored: formatSignedMessage({ address, message, signature }) });
}

function verifyFlow(text) {
  const c = classify(text, state.net);
  if (c.kind !== 'signature') throw new WalletError('err.notSignedMessage');
  const valid = verifyMessage(state.net, c.address, c.message, c.signature);
  showResult({ kind: 'verify', valid, address: c.address, message: c.message, armored: formatSignedMessage(c) });
}

// ---------------------------------------------------------------- scanning
let scanSession = null;

async function openScanner() {
  const dlg = $('dlgScan');
  $('scanText').value = '';
  $('scanStatus').textContent = t('scan.starting');
  show('scanProgress', false);
  const session = { scanner: null, done: false, ur: null };
  scanSession = session;
  dlg.addEventListener(
    'close',
    () => {
      session.done = true;
      session.scanner?.stop();
      if (scanSession === session) scanSession = null;
    },
    { once: true },
  );
  dlg.showModal();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('scan.noCameraApi'));
    const scanner = await startScanner($('scanVideo'), $('scanOverlay'), (text) => feedScan(session, text));
    if (session.done) scanner.stop();
    else {
      session.scanner = scanner;
      $('scanStatus').textContent = t('scan.aim');
    }
  } catch (e) {
    if (!session.done) $('scanStatus').textContent = t('scan.cameraError', { msg: e?.message || e?.name || String(e) });
  }
}

/** Handles one read QR text; returns true when scanning is finished. */
function feedScan(session, text) {
  if (/^ur:/i.test(text.trim())) {
    session.ur ??= new URDecoder();
    try {
      session.ur.receive(text);
    } catch {
      return false;
    }
    if (!session.ur.result) {
      show('scanProgress', true);
      $('scanProgress').value = session.ur.progress;
      $('scanStatus').textContent = t('scan.urProgress', { p: Math.round(session.ur.progress * 100) });
      return false;
    }
    const { type, cbor } = session.ur.result;
    finishScan(() => handleUR(type, cbor));
    return true;
  }
  finishScan(() => handleScanned(text));
  return true;
}

function finishScan(handler) {
  if ($('dlgScan').open) $('dlgScan').close();
  Promise.resolve()
    .then(handler)
    .catch(alertError);
}

async function handleUR(type, cbor) {
  if (PSBT_TYPES.includes(type)) {
    if (state.net.coin !== 'btc') throw new WalletError('err.psbtCoin', { coin: 'Bitcoin' });
    return handlePsbt(cborToPsbt(cbor));
  }
  if (type === BCH_PSBT_TYPE) {
    if (state.net.coin !== 'bch') throw new WalletError('err.psbtCoin', { coin: 'Bitcoin Cash' });
    return handlePsbt(cborToPsbt(cbor));
  }
  if (ACCOUNT_UR_TYPES.includes(type)) {
    const accounts = accountsFromUR(type, cbor).filter((a) => typesFor(state.net).includes(a.type));
    if (!accounts.length) throw new WalletError('err.urNoAccount');
    const want = $('typeSel').value;
    const a = accounts.find((x) => x.type === want) ?? accounts[0];
    if (state.account) logout();
    return loadXpubAccount(a.node, a.testnet, a.type, a.fingerprint, a.path);
  }
  throw new WalletError('err.urType', { type });
}

async function handlePsbt(bytes) {
  await reviewAndAct(bytes, { local: false });
}

async function handleScanned(text) {
  const c = classify(text, state.net);
  switch (c.kind) {
    case 'ur': {
      const d = new URDecoder();
      d.receive(text);
      if (!d.result) throw new WalletError('err.urIncomplete');
      return handleUR(d.result.type, d.result.cbor);
    }
    case 'psbt':
      return handlePsbt(c.bytes);
    case 'rawtx': {
      if (state.net.coin !== 'btc') return showResult({ kind: 'final', raw: c.hex, txid: '', rows: [], canBroadcast: true });
      const d = describeRawTx(c.hex, state.net);
      const rows = d.outputs.map((o) => [t('rv.pay'), `${coins(o.amount)} → ${o.address || t('rv.unknownScript')}`]);
      return showResult({ kind: 'final', raw: c.hex, txid: d.txid, rows, canBroadcast: true });
    }
    case 'payment':
      if (!state.account) {
        const r = parseRecipient(state.net, c.address);
        const type = { pkh: 'pkh', wpkh: 'wpkh', sh: 'sh-wpkh', tr: 'tr' }[r.kind];
        if (!type) throw new WalletError('err.addressType');
        setAccount({ ...singleAccountFromAddress(state.net, type, r.address, r.script), source: 'address' });
        return toast(t('scan.gotWatch'));
      }
      $('toAddr').value = c.address;
      if (c.amount) {
        setMax(false);
        $('amount').value = c.amount;
      }
      updateToHint();
      $('toAddr').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return toast(t('scan.gotRecipient'));
    case 'account': {
      const p = c.parsed;
      if (state.account) logout();
      const type = p.type ?? $('typeSel').value;
      return loadXpubAccount(p.node, p.testnet, type, p.fingerprint ?? 0, p.path ?? parsePath(accountPath(state.net, type, 0)));
    }
    case 'msgRequest':
      $('secAdv').open = true;
      $('msgInput').value = c.message;
      if (state.account && canSign(state.account)) return signMessageFlow(c.address, c.message);
      throw new WalletError('err.scanNeedKey');
    case 'signature':
      return verifyFlow(text);
    default:
      throw new WalletError('err.unknownPayload');
  }
}

// ---------------------------------------------------------------- language
function renderLanguage() {
  applyI18n(document);
  const en = getLang() === 'en';
  document.documentElement.lang = en ? 'en' : 'zh-Hant';
  $('btnLang').textContent = en ? '中文' : 'EN';
  $('btnLang').lang = en ? 'zh-Hant' : 'en';
  $('btnReveal').textContent = t($('keyInput').classList.contains('masked') ? 'acct.show' : 'acct.hide');
  const type = $('typeSel').value;
  $('typeSel').replaceChildren(...typesFor(state.net).map((x) => new Option(t(`type.${x}`), x)));
  $('typeSel').value = type || defaultType(state.net);
  setMax(state.sendMax);
  renderAccount();
  renderBalance();
  renderFeeChips();
  renderUtxos();
  renderHistory();
  updateToHint();
  renderResult();
}

// ---------------------------------------------------------------- wiring
function init() {
  initDialogs();
  initLang(store.get('oebw.lang', null));
  const net = getNetwork(store.get('oebw.net', 'btc')) ?? getNetwork('btc');
  applyNetwork(net);

  $('btnLang').addEventListener('click', () => {
    setLang(getLang() === 'en' ? 'zh-TW' : 'en');
    store.set('oebw.lang', getLang());
    renderLanguage();
  });
  for (const el of document.querySelectorAll('input[name="coin"]')) {
    el.addEventListener('change', () => {
      const first = NETWORKS.find((n) => n.coin === el.value);
      onNetworkChange(first.id).catch(alertError);
    });
  }
  $('netSel').addEventListener('change', () => onNetworkChange($('netSel').value).catch(alertError));
  $('serverUrl').addEventListener('change', onServerChange);

  $('keyInput').addEventListener('input', updateKeyOpts);
  $('btnReveal').addEventListener('click', () => {
    const masked = $('keyInput').classList.toggle('masked');
    $('btnReveal').textContent = t(masked ? 'acct.show' : 'acct.hide');
  });
  action('btnLoad', loadFromInput);
  action('btnVault', async () => {
    renderVaultList();
    await openDialog($('dlgVault'));
  });
  action('btnSync', sync);
  action('btnReceive', async () => showReceive());
  action('btnExport', async () => exportAccount());
  action('btnSaveVault', saveToVault);
  action('btnLogout', async () => logout());

  $('toAddr').addEventListener('input', updateToHint);
  action('btnMax', async () => setMax(!state.sendMax));
  action('btnSend', onSend);
  action('btnCopyResult', () => copyText($('resultText').value));
  action('btnBroadcast', broadcast, renderBroadcastStatus);
  action('btnSignMsg', () => signMessageFlow($('msgAddr').value, $('msgInput').value));
  action('btnVerify', async () => verifyFlow($('verifyInput').value));

  action('btnScan', openScanner);
  $('btnScanUse').addEventListener('click', () => {
    const text = $('scanText').value.trim();
    if (!text) return;
    const parts = text.split(/\s+/).filter((p) => /^ur:/i.test(p));
    // Pasted multi-part URs (one per line) are decoded together.
    if (parts.length > 1) {
      const d = new URDecoder();
      for (const p of parts) d.receive(p);
      if (d.result) return finishScan(() => handleUR(d.result.type, d.result.cbor));
      return finishScan(() => {
        throw new WalletError('err.urIncomplete');
      });
    }
    feedScan(scanSession ?? { ur: null }, text);
  });
  $('btnScanImage').addEventListener('click', () => $('scanFile').click());
  $('scanFile').addEventListener('change', async () => {
    const file = $('scanFile').files[0];
    $('scanFile').value = '';
    if (!file) return;
    try {
      feedScan(scanSession ?? { ur: null }, await decodeImageFile(file));
    } catch {
      $('scanStatus').textContent = t('scan.imageFail');
    }
  });
  $('btnScanSwitch').addEventListener('click', async () => {
    const ok = await scanSession?.scanner?.next().catch(() => false);
    if (!ok) toast(t('scan.oneCamera'));
  });

  action('btnClear', async () => {
    if (!(await confirmDialog({ title: t('foot.clearTitle'), warnings: [{ text: t('foot.clearBody') }], ok: t('foot.clear') }))) return;
    logout();
    for (const id of ['toAddr', 'amount', 'msgInput', 'verifyInput']) $(id).value = '';
    setMax(false);
    updateToHint();
  });

  renderLanguage();
}

init();
