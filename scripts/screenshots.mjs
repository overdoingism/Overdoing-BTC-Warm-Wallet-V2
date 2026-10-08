// Screenshots for visual review (not a test): node scripts/screenshots.mjs <outDir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { fund, mine, startRegtest, stopRegtest } from './regtest.mjs';
import { PHRASES, WALLET_URL, addressOf, useRegtest } from '../test/e2e/helpers.mjs';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
await startRegtest();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [name, opts] of [
    ['desktop', { viewport: { width: 1100, height: 900 } }],
    ['mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
    ['dark', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' }],
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('oebw.lang', '"zh-TW"'));
    await page.goto(WALLET_URL);
    const shot = (n, full = true) => page.screenshot({ path: join(out, `${name}-${n}.png`), fullPage: full });
    await shot('1-start');
    await useRegtest(page, 'btc');
    await page.fill('#keyInput', PHRASES.hot);
    await page.click('#btnReveal');
    await shot('2-input');
    await page.click('#btnLoad');
    await fund('btc', addressOf(PHRASES.hot, 'btc', 'wpkh', 0, 5), 0.25);
    await mine('btc');
    await page.click('#btnSync');
    await page.waitForSelector('#balanceBox:not([hidden])');
    await page.waitForTimeout(500);
    await page.fill('#toAddr', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
    await page.fill('#amount', '0.01');
    await page.locator('#coinControl > summary').click();
    await page.locator('#secHistory > summary').click();
    await shot('3-loaded');
    await page.click('#btnSend');
    await page.waitForSelector('#dlgConfirm[open]');
    await shot('4-review', false);
    await page.click('#cfOk');
    await page.waitForSelector('#secResult:not([hidden])');
    await page.waitForTimeout(400);
    await page.locator('#secResult').screenshot({ path: join(out, `${name}-5-result.png`) });
    await page.click('#btnSaveVault');
    await page.waitForSelector('#dlgPw[open]');
    await shot('6-vault', false);
    await page.keyboard.press('Escape');
    await page.click('#btnExport');
    await page.waitForSelector('#dlgQr[open]');
    await shot('7-export', false);
    await page.keyboard.press('Escape');
    await page.click('#btnLang');
    await page.locator('#secAdv > summary').click();
    await shot('8-english');
    await ctx.close();
  }
} finally {
  await browser.close();
  await stopRegtest();
}
