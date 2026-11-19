import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { subsetFamily } from '../../vite/font-subset';

const tokens = readFileSync('src/theme/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const fontJp = /--font-sans:\s*([^;]+);/u.exec(tokens)?.[1] ?? '';

const families = fontJp.split(',').map((name) => name.trim().replace(/^['"]|['"]$/gu, ''));

describe('--font-sans', () => {
  it('宣言されている', () => {
    expect(fontJp).not.toBe('');
  });

  it('語彙段・遅延段・system の順に並ぶ', () => {
    const subset = families.indexOf(subsetFamily);
    const fallback = families.indexOf('Noto Sans JP Variable');
    const system = families.indexOf('system-ui');

    expect(subset).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(subset);
    expect(system).toBeGreaterThan(fallback);
  });

  it('語彙段の名前が @font-face 側と一致する', () => {
    expect(families).toContain(subsetFamily);
  });

  it('最後は総称ファミリで閉じる', () => {
    expect(families.at(-1)).toBe('sans-serif');
  });
});
