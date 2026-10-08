import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import { getNetwork } from '../../src/core/networks.js';
import { accountPath, deriveAddress, hdAccountFromRoot, rootFromMnemonic } from '../../src/core/keys.js';
import { wsUrl } from '../../scripts/regtest.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WALLET_URL = pathToFileURL(join(ROOT, 'dist', 'oebw.html')).href;

// Separate wallets per test so balances never interfere.
export const PHRASES = {
  hot: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  airgap: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  bch: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  coin: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  msg: 'void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold',
  vault: 'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length',
};

export const netId = (coin) => `${coin}-regtest`;

/** The address the wallet derives for (phrase, coin, type) at chain/index. */
export function addressOf(phrase, coin, type, chain = 0, index = 0) {
  const net = getNetwork(netId(coin));
  const acc = hdAccountFromRoot(rootFromMnemonic(phrase, '', net), net, type, accountPath(net, type, 0));
  return deriveAddress(acc, chain, index).address;
}

/** Opens the wallet and collects page errors, CSP violations and unexpected requests. */
export async function openWallet(page, { lang = 'zh-TW' } = {}) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/getUserMedia|NotFoundError|NotAllowedError|Requested device/i.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => {
    const url = r.url();
    if (!/^(file|data|blob):/.test(url) && !/^wss?:\/\/127\.0\.0\.1:/.test(url)) problems.push(`request: ${url}`);
  });
  await page.addInitScript((l) => localStorage.setItem('oebw.lang', JSON.stringify(l)), lang);
  await page.goto(WALLET_URL);
  await expect(page.locator('#btnLoad')).not.toBeEmpty();
  return problems;
}

/** Selects the regtest network of a coin and points it at the local Fulcrum. */
export async function useRegtest(page, coin) {
  await page.locator(`input[name="coin"][value="${coin}"] + span`).click();
  await page.selectOption('#netSel', netId(coin));
  await page.fill('#serverUrl', wsUrl(coin));
  await page.locator('#serverUrl').dispatchEvent('change');
}

export async function loadKey(page, text, { type } = {}) {
  await page.fill('#keyInput', text);
  if (type) await page.selectOption('#typeSel', type);
  await page.click('#btnLoad');
  await expect(page.locator('#acctView')).toBeVisible();
}

export async function sync(page) {
  await page.click('#btnSync');
  await expect(page.locator('#balanceBox')).toBeVisible();
  await expect(page.locator('#dlgBusy')).toBeHidden();
}

/** Waits until the balance line shows `text` (re-syncing, since Fulcrum indexes asynchronously). */
export async function syncUntil(page, text) {
  await expect(async () => {
    await sync(page);
    await expect(page.locator('#balConfirmed')).toContainText(text, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
}

/** Clicks Send / Sign and accepts the review dialog; returns the review rows text. */
export async function sendViaForm(page) {
  await page.click('#btnSend');
  await expect(page.locator('#dlgConfirm')).toBeVisible();
  const rows = await page.locator('#cfRows').innerText();
  await page.click('#cfOk');
  await expect(page.locator('#secResult')).toBeVisible();
  return rows;
}

export async function broadcastAndWait(page) {
  await page.click('#btnBroadcast');
  await expect(page.locator('#bcastStatus')).toHaveClass(/\bok\b/, { timeout: 60_000 });
  return (await page.locator('#bcastStatus').innerText()).match(/[0-9a-f]{64}/)[0];
}

/** Feeds text through the scanner dialog's paste box (what a QR scan would deliver). */
export async function scanText(page, text) {
  await page.click('#btnScan');
  await expect(page.locator('#dlgScan')).toBeVisible();
  await page.fill('#scanText', text);
  await page.click('#btnScanUse');
}

/**
 * Moves a (possibly animated) QR code from one page to another the way a phone would:
 * screenshots of `from`'s QR image are fed to `to`'s "read from image" until it is done.
 */
export async function transferQr(fromImg, to) {
  await to.click('#btnScan');
  await expect(to.locator('#dlgScan')).toBeVisible();
  for (let i = 0; i < 200 && (await to.locator('#dlgScan').isVisible()); i++) {
    const png = await fromImg.screenshot();
    await to.setInputFiles('#scanFile', { name: 'qr.png', mimeType: 'image/png', buffer: png });
    await to.waitForTimeout(150);
  }
  await expect(to.locator('#dlgScan')).toBeHidden();
}
