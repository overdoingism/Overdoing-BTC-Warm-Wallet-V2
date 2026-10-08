import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import encodeQR from 'qr';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { getNetwork } from '../../src/core/networks.js';
import { accountPath, hdAccountFromRoot, rootFromMnemonic } from '../../src/core/keys.js';
import { parseRecipient } from '../../src/core/address.js';
import { UREncoder } from '../../src/core/ur.js';
import { accountToCbor } from '../../src/core/urtypes.js';
import { fund, mine, rpc } from '../../scripts/regtest.mjs';
import {
  PHRASES,
  WALLET_URL,
  addressOf,
  broadcastAndWait,
  loadKey,
  openWallet,
  scanText,
  sendViaForm,
  sync,
  syncUntil,
  transferQr,
  useRegtest,
} from './helpers.mjs';

const minerAddress = (coin) => rpc(coin, 'getnewaddress', [], 'miner');
const inMempool = async (coin, txid) => (await rpc(coin, 'getrawmempool')).includes(txid);

test('loads with no network traffic, no errors, and switches language', async ({ page }) => {
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  const problems = await openWallet(page);
  await page.waitForTimeout(1500);
  expect(seen.filter((u) => !/^(file|data):/.test(u))).toEqual([]);
  await expect(page.locator('#btnLoad')).toHaveText('載入');
  await page.click('#btnLang');
  await expect(page.locator('#btnLoad')).toHaveText('Load');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#typeSel option').first()).toHaveText('Native SegWit (bc1q…)');
  expect(problems).toEqual([]);
});

test('the built file is self-contained', async () => {
  const html = readFileSync(new URL(WALLET_URL), 'utf8');
  expect(html).not.toMatch(/<script[^>]+src=/i);
  expect(html).not.toMatch(/<link[^>]+href=/i);
  expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; script-src 'sha256-/);
});

test('hot wallet (Native SegWit): receive, send with change, then speed up with RBF', async ({ page }) => {
  const problems = await openWallet(page);
  await useRegtest(page, 'btc');
  await loadKey(page, PHRASES.hot);
  await expect(page.locator('#acctBadge')).toHaveClass(/signer/);
  await expect(page.locator('#acctType')).toHaveText(/Native SegWit/);

  await fund('btc', addressOf(PHRASES.hot, 'btc', 'wpkh'), 1);
  await mine('btc');
  await syncUntil(page, '1 rBTC');

  // The receive address moves past the used one.
  await page.click('#btnReceive');
  await expect(page.locator('#qrText')).toHaveText(addressOf(PHRASES.hot, 'btc', 'wpkh', 0, 1));
  await page.locator('#dlgQr [data-close]').click();

  const to = await minerAddress('btc');
  await page.fill('#toAddr', to);
  await expect(page.locator('#toHint')).toHaveClass(/ok/);
  await page.fill('#amount', '0.1');
  await page.fill('#feeRate', '2');
  const rows = await sendViaForm(page);
  expect(rows).toContain(`0.1 rBTC → ${to}`);
  expect(rows).toContain('✓ 已驗證是你的地址');
  await expect(page.locator('#resultTitle')).toHaveText('已簽名交易');
  const first = await broadcastAndWait(page);
  expect(await inMempool('btc', first)).toBe(true);

  // History offers "speed up" for our unconfirmed RBF payment.
  await page.locator('#secHistory > summary').click();
  const bump = page.locator('#historyList button', { hasText: '加速' });
  await expect(async () => {
    await sync(page);
    await expect(bump).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await page.fill('#feeRate', '15');
  await bump.click();
  await expect(page.locator('#dlgConfirm')).toBeVisible();
  await expect(page.locator('#cfRows')).toContainText(`0.1 rBTC → ${to}`);
  await page.click('#cfOk');
  const second = await broadcastAndWait(page);
  expect(second).not.toBe(first);
  expect(await inMempool('btc', second)).toBe(true);
  expect(await inMempool('btc', first)).toBe(false);
  await mine('btc');
  expect((await rpc('btc', 'getrawtransaction', [second, true])).vout.some((o) => o.value === 0.1 && o.scriptPubKey.address === to)).toBe(true);
  expect(problems).toEqual([]);
});

test('air-gapped: Taproot signer offline, watch-only online, PSBTs moved as animated QR images', async ({ context }) => {
  const signer = await context.newPage();
  const online = await context.newPage();
  const signerRequests = [];
  signer.on('request', (r) => signerRequests.push(r.url()));
  const problems = [...(await openWallet(signer)), ...(await openWallet(online))];

  // Offline device: mnemonic only, no server.
  await signer.selectOption('#netSel', 'btc-regtest');
  await loadKey(signer, PHRASES.airgap, { type: 'tr' });
  await expect(signer.locator('#offlineHint')).toBeVisible();

  // Online device imports the account by scanning the exported crypto-account UR.
  await useRegtest(online, 'btc');
  await signer.click('#btnExport');
  await expect(signer.locator('#qrText')).toHaveText(/^tr\(\[[0-9a-f]{8}\/86'\/1'\/0'\]tpub/);
  await transferQr(signer.locator('#qrImg'), online);
  await signer.locator('#dlgQr [data-close]').click();
  await expect(online.locator('#acctBadge')).toHaveClass(/watch/);
  await expect(online.locator('#acctType')).toHaveText(/Taproot/);

  await fund('btc', addressOf(PHRASES.airgap, 'btc', 'tr'), 0.5);
  await mine('btc');
  await syncUntil(online, '0.5 rBTC');
  const to = await minerAddress('btc');
  await online.fill('#toAddr', to);
  await online.fill('#amount', '0.2');
  await online.fill('#feeRate', '3');
  await expect(online.locator('#btnSend')).toHaveText('建立待簽 QR');
  await sendViaForm(online);
  await expect(online.locator('#resultTitle')).toHaveText('待簽名交易（PSBT）');
  await expect(online.locator('#btnBroadcast')).toBeHidden();

  // Offline device scans, reviews and signs.
  await transferQr(online.locator('#resultQr'), signer);
  await expect(signer.locator('#cfTitle')).toHaveText('最終檢查（簽名）');
  await expect(signer.locator('#cfRows')).toContainText(`0.2 rBTC → ${to}`);
  await expect(signer.locator('#cfWarn li.danger')).toHaveCount(0);
  await signer.click('#cfOk');
  await expect(signer.locator('#resultTitle')).toHaveText('已簽名交易');
  await expect(signer.locator('#btnBroadcast')).toBeHidden();

  // Back to the online device, which broadcasts.
  await transferQr(signer.locator('#resultQr'), online);
  await expect(online.locator('#cfTitle')).toHaveText('交易內容');
  await online.click('#cfOk');
  await expect(online.locator('#resultTitle')).toHaveText('可廣播的交易');
  const txid = await broadcastAndWait(online);
  expect(await inMempool('btc', txid)).toBe(true);

  expect(signerRequests.filter((u) => !/^(file|data|blob):/.test(u))).toEqual([]);
  expect(problems).toEqual([]);
});

test('Bitcoin Cash: legacy address converted to CashAddr, send, then send everything', async ({ page }) => {
  const problems = await openWallet(page);
  await useRegtest(page, 'bch');
  await expect(page.locator('#typeRow')).toBeHidden();
  await loadKey(page, PHRASES.bch);
  await fund('bch', addressOf(PHRASES.bch, 'bch', 'pkh'), 2);
  await fund('bch', addressOf(PHRASES.bch, 'bch', 'pkh', 0, 3), 1);
  await mine('bch');
  await syncUntil(page, '3 rBCH');

  const cash = await minerAddress('bch');
  const script = parseRecipient(getNetwork('bch-regtest'), cash).script;
  const legacy = createBase58check(sha256).encode(Uint8Array.of(0x6f, ...script.slice(3, 23)));
  await page.fill('#toAddr', legacy);
  await expect(page.locator('#toHint')).toContainText(`舊式地址已轉為 ${cash}`);
  await page.fill('#amount', '0.5');
  await page.fill('#feeRate', '1');
  const rows = await sendViaForm(page);
  expect(rows).toContain(`0.5 rBCH → ${cash}`);
  const txid = await broadcastAndWait(page);
  expect(await inMempool('bch', txid)).toBe(true);

  await mine('bch');
  await sync(page);
  await page.click('#btnMax');
  await expect(page.locator('#amount')).toBeDisabled();
  await sendViaForm(page);
  const all = await broadcastAndWait(page);
  await mine('bch');
  const tx = await rpc('bch', 'getrawtransaction', [all, true]);
  expect(tx.vout).toHaveLength(1);
  await syncUntil(page, '0 rBCH');
  expect(problems).toEqual([]);
});

test('coin control spends only the ticked UTXO (Nested SegWit)', async ({ page }) => {
  const problems = await openWallet(page);
  await useRegtest(page, 'btc');
  await loadKey(page, PHRASES.coin, { type: 'sh-wpkh' });
  const addr = addressOf(PHRASES.coin, 'btc', 'sh-wpkh');
  expect(addr).toMatch(/^2/);
  const small = await fund('btc', addr, 0.3);
  await fund('btc', addr, 0.7);
  await mine('btc');
  await syncUntil(page, '1 rBTC');

  await page.locator('#coinControl > summary').click();
  await page.locator('#utxoList li', { hasText: /^0\.3/ }).locator('input').check();
  await page.fill('#toAddr', await minerAddress('btc'));
  await page.fill('#feeRate', '2');
  await page.click('#btnMax');
  const rows = await sendViaForm(page);
  expect(rows).toMatch(/1 筆，合計 0\.3 rBTC/);
  const txid = await broadcastAndWait(page);
  const tx = await rpc('btc', 'getrawtransaction', [txid, true]);
  expect(tx.vin.map((i) => i.txid)).toEqual([small]);
  expect(tx.vout).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('messages: BIP137 accepted by Bitcoin Core; watch-only request signed offline (BIP322 Taproot)', async ({ context }) => {
  const page = await context.newPage();
  const problems = await openWallet(page);
  await page.selectOption('#netSel', 'btc-regtest');
  await loadKey(page, PHRASES.msg, { type: 'pkh' });
  const address = addressOf(PHRASES.msg, 'btc', 'pkh');
  await page.locator('#secAdv > summary').click();
  await expect(page.locator('#msgAddr')).toHaveValue(address);
  await page.fill('#msgInput', 'hello regtest');
  await page.click('#btnSignMsg');
  await page.click('#cfOk');
  await expect(page.locator('#resultTitle')).toHaveText('訊息簽名');
  const armored = await page.locator('#resultText').inputValue();
  const signature = armored.match(/-----BEGIN SIGNATURE-----\n(?:.*\n)?(\S+)\n-----END/)[1];
  expect(await rpc('btc', 'verifymessage', [address, signature, 'hello regtest'])).toBe(true);

  await page.fill('#verifyInput', armored);
  await page.click('#btnVerify');
  await expect(page.locator('#resultRows')).toContainText('✓ 簽名有效');
  await page.fill('#verifyInput', armored.replace('hello regtest', 'hello regtesT'));
  await page.click('#btnVerify');
  await expect(page.locator('#resultRows')).toContainText('✗ 簽名無效');

  // Watch-only Taproot address asks an offline signer by QR.
  const tr = addressOf(PHRASES.msg, 'btc', 'tr');
  const online = await context.newPage();
  problems.push(...(await openWallet(online)));
  await online.selectOption('#netSel', 'btc-regtest');
  await loadKey(online, tr);
  await expect(online.locator('#acctBadge')).toHaveClass(/watch/);
  await online.locator('#secAdv > summary').click();
  await online.fill('#msgInput', 'proof of reserves\nline two');
  await expect(online.locator('#btnSignMsg')).toHaveText('產生待簽訊息 QR');
  await online.click('#btnSignMsg');
  await expect(online.locator('#resultTitle')).toHaveText('待簽名訊息');

  await page.click('#btnLogout');
  await loadKey(page, PHRASES.msg, { type: 'tr' });
  await transferQr(online.locator('#resultQr'), page);
  await expect(page.locator('#cfRows')).toContainText('proof of reserves');
  await page.click('#cfOk');
  await expect(page.locator('#resultTitle')).toHaveText('訊息簽名');
  await transferQr(page.locator('#resultQr'), online);
  await expect(online.locator('#resultTitle')).toHaveText('簽名驗證');
  await expect(online.locator('#resultRows')).toContainText('✓ 簽名有效');
  await expect(online.locator('#resultRows')).toContainText(tr);
  expect(problems).toEqual([]);
});

test('encrypted vault: risks shown and acknowledged, unlock after reload, wrong password and passphrase refused', async ({ page }) => {
  test.setTimeout(240_000);
  const problems = await openWallet(page);
  await page.selectOption('#netSel', 'btc-regtest');
  await page.fill('#keyInput', PHRASES.vault);
  await page.fill('#passphrase', 'extra words');
  await page.click('#btnLoad');
  const origin = await page.locator('#acctOrigin').innerText();

  await page.click('#btnSaveVault');
  await expect(page.locator('#pwIntro')).toContainText('離線狀態下無限次嘗試破解密碼');
  await expect(page.locator('#pwIntro')).toContainText('BIP39 密語不會被儲存');
  await page.fill('#pwName', 'daily');
  await page.fill('#pw1', 'correct horse');
  await page.fill('#pw2', 'correct horse');
  await page.click('#pwOk');
  await expect(page.locator('#pwErr')).toHaveText('請先勾選「我已了解以上風險」');
  await page.check('#pwAck');
  await page.click('#pwOk');
  await expect(page.locator('#toast')).toHaveText('已加密儲存', { timeout: 60_000 });
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain('hamster');

  await page.reload();
  await page.click('#btnVault');
  await page.locator('#vaultList li', { hasText: 'daily' }).getByRole('button', { name: '開啟' }).click();
  await page.fill('#pw1', 'wrong horse');
  await page.click('#pwOk');
  await expect(page.locator('#alMsg')).toHaveText('密碼錯誤。', { timeout: 60_000 });
  await page.locator('#dlgAlert [data-close]').click();

  await page.click('#btnVault');
  await page.locator('#vaultList li', { hasText: 'daily' }).getByRole('button', { name: '開啟' }).click();
  await page.fill('#pw1', 'correct horse');
  await page.click('#pwOk');
  await expect(page.locator('#pwTitle')).toHaveText('BIP39 密語', { timeout: 60_000 });
  await page.fill('#pw1', 'other words');
  await page.click('#pwOk');
  await expect(page.locator('#alMsg')).toContainText('BIP39 密語不正確');
  await page.locator('#dlgAlert [data-close]').click();

  await page.click('#btnVault');
  await page.locator('#vaultList li', { hasText: 'daily' }).getByRole('button', { name: '開啟' }).click();
  await page.fill('#pw1', 'correct horse');
  await page.click('#pwOk');
  await expect(page.locator('#pwTitle')).toHaveText('BIP39 密語', { timeout: 60_000 });
  await page.fill('#pw1', 'extra words');
  await page.click('#pwOk');
  await expect(page.locator('#acctOrigin')).toHaveText(origin);
  await expect(page.locator('#acctBadge')).toHaveClass(/signer/);
  expect(problems).toEqual([]);
});

test('scanned PSBT that tampers with a previous transaction is refused', async ({ page }) => {
  const problems = await openWallet(page);
  await useRegtest(page, 'btc');
  await loadKey(page, PHRASES.hot, { type: 'pkh' });
  const funding = await fund('btc', addressOf(PHRASES.hot, 'btc', 'pkh'), 0.2);
  await mine('btc');
  await syncUntil(page, '0.2 rBTC');
  // Build an unsigned request on a watch-only copy, then lie about the input's previous tx.
  await page.click('#btnExport');
  const descriptor = await page.locator('#qrText').innerText();
  await page.locator('#dlgQr [data-close]').click();
  const watch = await page.context().newPage();
  await openWallet(watch);
  await useRegtest(watch, 'btc');
  await loadKey(watch, descriptor);
  await sync(watch);
  await watch.fill('#toAddr', await minerAddress('btc'));
  await watch.fill('#amount', '0.05');
  await watch.fill('#feeRate', '2');
  await sendViaForm(watch);
  const psbt = Buffer.from(await watch.locator('#resultText').inputValue(), 'base64');
  // Change one amount inside the attached previous transaction (its txid no longer matches).
  const { Transaction } = await import('@scure/btc-signer');
  const prevRaw = Buffer.from(await rpc('btc', 'getrawtransaction', [funding]), 'hex');
  const prev = Transaction.fromRaw(prevRaw, { allowUnknownOutputs: true });
  const body = [prevRaw, Buffer.from(prev.toBytes(true, false))].find((b) => psbt.indexOf(b) > 0);
  const amount = prev.getOutput(0).amount;
  const amountAt = psbt.indexOf(body) + body.indexOf(Buffer.from(new BigUint64Array([amount]).buffer));
  psbt.writeBigUInt64LE(amount + 100_000n, amountAt);
  await scanText(page, psbt.toString('base64'));
  await expect(page.locator('#alMsg')).toContainText('可能被竄改');
  expect(problems).toEqual([]);
});

/** A looping Y4M video showing each text as a QR code for a few frames (Chromium's fake camera). */
function qrVideo(texts, framesEach = 3) {
  const W = 640;
  const H = 480;
  const frames = texts.map((text) => {
    const matrix = encodeQR(text, 'raw', { border: 4, ecc: 'low' });
    const scale = Math.floor((Math.min(W, H) * 0.9) / matrix.length);
    const ox = Math.floor((W - matrix.length * scale) / 2);
    const oy = Math.floor((H - matrix.length * scale) / 2);
    const y = Buffer.alloc(W * H, 235);
    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix.length; c++) {
        if (!matrix[r][c]) continue;
        for (let dy = 0; dy < scale; dy++) y.fill(16, (oy + r * scale + dy) * W + ox + c * scale, (oy + r * scale + dy) * W + ox + (c + 1) * scale);
      }
    }
    const frame = Buffer.concat([Buffer.from('FRAME\n'), y, Buffer.alloc((W / 2) * (H / 2) * 2, 128)]);
    return Array(framesEach).fill(frame);
  });
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...frames.flat()]);
}

test('the camera reads an animated UR (crypto-account)', async () => {
  const net = getNetwork('btc-regtest');
  const acc = hdAccountFromRoot(rootFromMnemonic(PHRASES.airgap, '', net), net, 'wpkh', accountPath(net, 'wpkh', 0));
  const enc = new UREncoder('crypto-account', accountToCbor(acc), 30);
  expect(enc.isSinglePart).toBe(false);
  const parts = Array.from({ length: enc.seqLen * 2 }, () => enc.nextPart().toUpperCase());
  const video = join(tmpdir(), `oebw-ur-${process.pid}.y4m`);
  writeFileSync(video, qrVideo(parts));
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  try {
    const page = await browser.newPage();
    const problems = await openWallet(page);
    await page.selectOption('#netSel', 'btc-regtest');
    await page.click('#btnScan');
    await expect(page.locator('#acctView')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#acctBadge')).toHaveClass(/watch/);
    await expect(page.locator('#acctOrigin')).toContainText(`/84'/1'/0'`);
    await expect(page.locator('#dlgScan')).toBeHidden();
    expect(problems).toEqual([]);
  } finally {
    await browser.close();
  }
});
