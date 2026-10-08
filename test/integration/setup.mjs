import { startRegtest, stopRegtest } from '../../scripts/regtest.mjs';

export async function setup() {
  await startRegtest();
}

export async function teardown() {
  await stopRegtest();
}
