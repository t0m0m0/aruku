// Material 3 の決まり事（色の役割・文字の段階・角丸の段階）をトークンとして持つこと。
// 値そのものは material-color-utilities の算出結果で、ここでは固定しない——固定するのは
// 「役割が揃っている」「対になる前景が読める」「段階の数値」の3点。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 散文の中の `--color-…` を宣言だと読まないよう、コメントを先に落とす
// （test/theme/font-stack.test.ts と同じ理由）。
const tokens = readFileSync('src/theme/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function declared(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`, 'u').exec(tokens)?.[1].trim();
}

function color(role: string): string {
  const value = declared(`color-${role}`);
  if (value === undefined || !/^#[0-9a-f]{6}$/u.test(value)) {
    throw new Error(`--color-${role} が 6 桁の hex で宣言されていない: ${String(value)}`);
  }
  return value;
}

/// WCAG 2.x の相対輝度によるコントラスト比。
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('色の役割', () => {
  const surfaces = [
    'surface',
    'surface-container-lowest',
    'surface-container-low',
    'surface-container',
    'surface-container-high',
    'surface-container-highest',
  ];

  // 前景と背景の組。M3 の on-X は X の上に載せる前提の色で、本文の 4.5:1 を満たす。
  const pairs: [string, string][] = [
    ['on-primary', 'primary'],
    ['on-primary-container', 'primary-container'],
    ['on-secondary-container', 'secondary-container'],
    ['on-error', 'error'],
    ['on-error-container', 'error-container'],
    ['on-ride', 'ride'],
    ['on-ride-container', 'ride-container'],
    ...surfaces.flatMap((s): [string, string][] => [
      ['on-surface', s],
      ['on-surface-variant', s],
      // 面の上に直接置く文字色としての primary と ride（テキストボタン・区間の所要）。
      ['primary', s],
      ['ride', s],
    ]),
  ];

  it.each(pairs)('%s は %s の上で 4.5:1 以上', (fg, bg) => {
    expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('outline と outline-variant がある', () => {
    expect(() => color('outline')).not.toThrow();
    expect(() => color('outline-variant')).not.toThrow();
  });

  // 面の濃淡で階層を作る（影に頼らない）。段階が逆転すると「上に載っている」が崩れる。
  it('surface-container は lowest から highest へ順に暗くなる', () => {
    const lightness = surfaces
      .slice(1)
      .map((s) => contrast(color(s), '#000000'));
    expect(lightness).toEqual([...lightness].sort((a, b) => b - a));
  });

  // shadcn の部品（Button など）が bg-primary で引く色。M3 の primary と別の値を持つと、
  // 同じ「主要な操作」が部品と画面で2色になる。
  it('shadcn の --primary は M3 の primary を指す', () => {
    expect(declared('primary')).toBe('var(--color-primary)');
    expect(declared('primary-foreground')).toBe('var(--color-on-primary)');
  });
});

describe('文字の段階', () => {
  it.each([
    ['title-large', '1.375rem', '1.75rem', '400'],
    ['title-medium', '1rem', '1.5rem', '500'],
    ['title-small', '0.875rem', '1.25rem', '500'],
    ['body-large', '1rem', '1.5rem', '400'],
    ['body-medium', '0.875rem', '1.25rem', '400'],
    ['body-small', '0.75rem', '1rem', '400'],
    ['label-large', '0.875rem', '1.25rem', '500'],
    ['label-medium', '0.75rem', '1rem', '500'],
  ])('%s は %s / 行高 %s / 太さ %s', (name, size, lineHeight, weight) => {
    expect(declared(`text-${name}`)).toBe(size);
    expect(declared(`text-${name}--line-height`)).toBe(lineHeight);
    expect(declared(`text-${name}--font-weight`)).toBe(weight);
  });
});

describe('角丸の段階', () => {
  it.each([
    ['extra-small', '4px'],
    ['small', '8px'],
    ['medium', '12px'],
    ['large', '16px'],
    ['extra-large', '28px'],
  ])('%s は %s', (name, value) => {
    expect(declared(`radius-${name}`)).toBe(value);
  });
});
