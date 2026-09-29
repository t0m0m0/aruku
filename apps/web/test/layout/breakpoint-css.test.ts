// 幅の出し分けは2つの入口に分かれる。DOM から消す／挙動が変わるものは `useIsDesktop`
// （JS）、見た目だけのものは Tailwind の `desktop:`。境界の数値はそれぞれに書くことに
// なるので、ここで一致を固定する——片方だけ動かしても、どちらの層のテストも赤く
// ならない（jsdom は CSS を読まず、Playwright は一方の幅しか見ていない）。

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

/// コメントを落としてから読む。落とさないと、決定を説明している散文中の `820px` を
/// 規則だと読んでしまう（test/theme/font-stack.test.ts が同じ理由で落としている）。
function rules(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

// `desktop:` は .tsx 側に書かれるので、境界の数値は @theme の側で押さえる。既定の
// sm / md / lg を残すと、`md:`（768px）のような別の境界がクラス名だけで紛れ込むので、
// それらが消えていることも見る。
const breakpoints = cssFiles('src').flatMap((path) =>
  [...rules(path).matchAll(/--breakpoint-([\w*-]+):\s*([^;]+);/g)].map(
    (match) => [match[1], match[2].trim()],
  ),
);

describe('Tailwind のブレークポイント', () => {
  it('既定を消し、desktop だけを desktopBreakpointPx で置く', () => {
    expect(breakpoints).toEqual([
      ['*', 'initial'],
      ['desktop', `${desktopBreakpointPx}px`],
    ]);
  });
});

// CSS に幅のメディアクエリを直書きすると、@theme の境界を通らずに別の数値が入り得る。
// 今は1つも無いので空であることを見る——書くなら `desktop:` を使う。
const widths = cssFiles('src').flatMap((path) =>
  [...rules(path).matchAll(/@media[^{]*?\((?:min|max)-width:\s*([\d.]+)px\)/g)].map(
    (match) => ({ path, px: Number(match[1]) }),
  ),
);

describe('CSS の幅の境界', () => {
  it('幅のメディアクエリを CSS に直書きしない', () => {
    expect(widths).toEqual([]);
  });
});
