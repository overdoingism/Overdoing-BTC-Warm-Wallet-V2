import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built single file (dist/oebw.html) through file:// in the
// installed Edge, against local regtest chains (Bitcoin Core / Bitcoin Cash Node + Fulcrum).
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  globalSetup: './test/e2e/global-setup.mjs',
  use: {
    channel: 'msedge',
    headless: true,
    viewport: { width: 900, height: 1100 },
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
});
