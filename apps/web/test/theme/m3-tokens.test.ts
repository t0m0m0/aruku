import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('surface-container は lowest から highest へ順に暗くなる', () => {
    const lightness = surfaces.slice(1).map((s) => contrast(color(s), '#000000'));
    expect(lightness).toEqual([...lightness].sort((a, b) => b - a));
  });

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
