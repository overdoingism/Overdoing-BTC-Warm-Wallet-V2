// Opt-in check that the default public servers work from a file:// page (CORS, CSP, protocol).
// Read-only: syncs a fresh, never-used address on each network. Run with OEBW_PUBLIC=1.
import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { NETWORKS } from '../../src/core/networks.js';
import { singleAccountFromWif } from '../../src/core/keys.js';
import { WALLET_URL } from './helpers.mjs';

test.skip(!process.env.OEBW_PUBLIC, 'set OEBW_PUBLIC=1 to query public servers');

for (const net of NETWORKS.filter((n) => n.servers.length)) {
  for (const server of net.servers) {
    test(`${net.id} via ${server}`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const address = singleAccountFromWif(randomBytes(32), net, net.coin === 'bch' ? 'pkh' : 'wpkh').address;
      await page.goto(WALLET_URL);
      await page.locator(`input[name="coin"][value="${net.coin}"] + span`).click();
      await page.selectOption('#netSel', net.id);
      await page.fill('#serverUrl', server);
      await page.fill('#keyInput', address);
      await page.click('#btnLoad');
      await page.click('#btnSync');
      await expect(page.locator('#dlgAlert')).toBeHidden();
      await expect(page.locator('#balConfirmed')).toHaveText(`0 ${net.symbol}`);
      await expect(page.locator('#balSynced')).toContainText(/#\d{5,}/);
      expect(errors).toEqual([]);
    });
  }
}
