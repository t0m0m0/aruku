// 幅の出し分けは2つの入口に分かれる。DOM から消す／挙動が変わるものは `useIsDesktop`
// （JS）、見た目だけのものは CSS のメディアクエリ。境界の数値はそれぞれに書くことに
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
/// 規則だと読んでしまう（test/theme/base-css.test.ts が同じ理由で落としている）。
function rules(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const widths = cssFiles('src').flatMap((path) =>
  [...rules(path).matchAll(/@media[^{]*?\((?:min|max)-width:\s*([\d.]+)px\)/g)].map(
    (match) => ({ path, px: Number(match[1]) }),
  ),
);

describe('CSS の幅の境界', () => {
  it('ブレークポイントを使っている CSS がある', () => {
    // 空振りしていないことの確認。CSS 側の出し分けが消えると、下の一致検査は
    // 何も見ないまま緑になる。
    expect(widths.length).toBeGreaterThan(0);
  });

  it('すべて desktopBreakpointPx と同じ', () => {
    expect(widths.filter((w) => w.px !== desktopBreakpointPx)).toEqual([]);
  });
});
