// Builds the single-file wallet and starts the regtest chains for the whole run.
import { execFileSync } from 'node:child_process';
import { startRegtest, stopRegtest } from '../../scripts/regtest.mjs';
import { ROOT } from './helpers.mjs';

export default async function globalSetup() {
  execFileSync(process.execPath, ['build.mjs'], { cwd: ROOT, stdio: 'inherit' });
  await startRegtest();
  return () => stopRegtest();
}
