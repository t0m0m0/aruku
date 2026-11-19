import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { desktopBreakpointPx } from '../../src/layout/breakpoints';

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

function rules(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const breakpoints = cssFiles('src').flatMap((path) =>
  [...rules(path).matchAll(/--breakpoint-([\w*-]+):\s*([^;]+);/g)].map((match) => [
    match[1],
    match[2].trim(),
  ]),
);

describe('Tailwind のブレークポイント', () => {
  it('既定を消し、desktop だけを desktopBreakpointPx で置く', () => {
    expect(breakpoints).toEqual([
      ['*', 'initial'],
      ['desktop', `${desktopBreakpointPx}px`],
    ]);
  });
});

const widths = cssFiles('src').flatMap((path) =>
  [...rules(path).matchAll(/@media[^{]*?\((?:min|max)-width:\s*([\d.]+)px\)/g)].map((match) => ({
    path,
    px: Number(match[1]),
  })),
);

describe('CSS の幅の境界', () => {
  it('幅のメディアクエリを CSS に直書きしない', () => {
    expect(widths).toEqual([]);
  });
});
