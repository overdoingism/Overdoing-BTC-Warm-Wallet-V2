import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DICT } from '../../src/i18n.js';

const src = (f) => readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8');
const files = ['main.js', 'ui/dialogs.js', 'ui/dom.js', ...readdirSync(new URL('../../src/core/', import.meta.url)).map((f) => `core/${f}`)];
const sources = files.map(src).join('\n');

describe('translations', () => {
  const zh = Object.keys(DICT['zh-TW']);
  const en = Object.keys(DICT.en);

  it('has the same keys in both languages', () => {
    expect(zh.filter((k) => !(k in DICT.en))).toEqual([]);
    expect(en.filter((k) => !(k in DICT['zh-TW']))).toEqual([]);
  });

  it('covers every key the HTML and the code refer to', () => {
    const namespaces = new Set(zh.map((k) => k.split('.')[0]));
    const used = new Set([
      ...[...src('index.html').matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map((m) => m[1]),
      ...[...sources.matchAll(/'([a-zA-Z0-9]+)\.([a-zA-Z0-9-]+)'/g)].filter((m) => namespaces.has(m[1])).map((m) => `${m[1]}.${m[2]}`),
    ]);
    // Keys built from a prefix at runtime.
    for (const p of ['type', 'kind', 'fee']) for (const k of zh.filter((x) => x.startsWith(`${p}.`))) used.add(k);
    expect(used.size).toBeGreaterThan(200);
    expect([...used].filter((k) => !(k in DICT['zh-TW']))).toEqual([]);
  });

  it('uses the same placeholders in both languages', () => {
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    expect(zh.filter((k) => vars(DICT['zh-TW'][k]) !== vars(DICT.en[k]))).toEqual([]);
  });
});
