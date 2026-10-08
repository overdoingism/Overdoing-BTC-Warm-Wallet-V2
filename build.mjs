// Builds dist/oebw.html: one self-contained file with all JavaScript and CSS inlined.
// A Content-Security-Policy with hashes of exactly that script and style is added, so
// nothing else can run in the page and it cannot load external code.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outFile = join(root, 'dist', 'oebw.html');
const target = ['chrome100', 'firefox100', 'safari15.4'];

const js = await esbuild.build({
  entryPoints: [join(root, 'src', 'main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target,
  legalComments: 'none',
  charset: 'utf8',
  metafile: true,
  write: false,
});
// Keep the HTML parser from ever seeing a closing tag or comment opener inside the script.
const script = js.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const css = (await esbuild.transform(readFileSync(join(root, 'src', 'style.css'), 'utf8'), { loader: 'css', minify: true, target })).code.trim();

const sha256 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const csp = [
  "default-src 'none'",
  `script-src ${sha256(script)}`,
  `style-src ${sha256(css)}`,
  'img-src data: blob:',
  'media-src blob: mediastream:',
  // Esplora (https/http) and Electrum-over-WebSocket (wss/ws) servers chosen by the user.
  'connect-src https: http: wss: ws:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

// Third-party notices for every package that ended up in the bundle.
function notices() {
  const names = new Set();
  const inputs = Object.values(js.metafile.outputs)[0].inputs;
  for (const [input, { bytesInOutput }] of Object.entries(inputs)) {
    const m = input.replace(/\\/g, '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m && bytesInOutput > 0) names.add(m[1]);
  }
  return [...names].sort().map((name) => {
    const dir = join(root, 'node_modules', name);
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // Dual-licensed packages (e.g. "MIT OR Apache-2.0") are used under MIT.
    if (!/\bMIT\b/.test(p.license)) throw new Error(`${name} is ${p.license}; update the notice header`);
    const files = readdirSync(dir);
    const lic = files.find((f) => /^licen[cs]e-mit/i.test(f)) ?? files.find((f) => /^licen[cs]e/i.test(f));
    const owners = lic
      ? readFileSync(join(dir, lic), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^copyright \(c\)/i.test(l))
      : [];
    return ` * ${p.name} ${p.version} (${p.license})${owners.map((o) => `\n *     ${o}`).join('')}`;
  });
}

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 * to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 * FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.`;

// The project's own copyright line comes from LICENSE, so there is one place to edit it.
const ownCopyright = readFileSync(join(root, 'LICENSE'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .find((l) => /^copyright \(c\)/i.test(l));
if (!ownCopyright) throw new Error('LICENSE has no "Copyright (c)" line');

const header = `<!--
 * Overdoing BTC Warm Wallet v${pkg.version}
 * An online / offline (air-gapped) Bitcoin & Bitcoin Cash wallet in a single HTML file, by overdoingism Lab.
 * Code written by Claude AI (Anthropic), following the design of overdoingism's Overdoing ETH Warm Wallet.
 * https://github.com/overdoingism/Overdoing-BTC-Warm-Wallet-V2
 * ${ownCopyright}
 * License: MIT (text below).
 *
 * Bundled third-party libraries, also under the MIT license:
${notices().join('\n')}
 *
 * MIT license text: ${MIT}
-->`;

const html = readFileSync(join(root, 'src', 'index.html'), 'utf8')
  .replace('<!doctype html>', `<!doctype html>\n${header}`)
  .replace('__CSP__', csp)
  .replace(/__VERSION__/g, pkg.version)
  .replace('__CSS__', () => css)
  .replace('__JS__', () => script);

if (!existsSync(dirname(outFile))) mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
// The build is deterministic, so anyone can rebuild from source and compare this hash.
const digest = createHash('sha256').update(html, 'utf8').digest('hex');
writeFileSync(join(dirname(outFile), 'SHA256SUMS'), `${digest}  oebw.html\n`);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`dist/oebw.html  ${kb(Buffer.byteLength(html))}  (script ${kb(script.length)}, style ${kb(css.length)})  sha256 ${digest}`);
