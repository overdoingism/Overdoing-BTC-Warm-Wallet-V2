import { defineConfig } from 'vitest/config';

// Wallet core against real regtest nodes (Bitcoin Core, Bitcoin Cash Node, Fulcrum).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.js'],
    globalSetup: ['test/integration/setup.mjs'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
