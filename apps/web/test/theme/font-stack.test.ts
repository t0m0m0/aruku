// `--font-jp` は二段構えの境目そのもの。並びが本体で、入れ替えると静かに壊れる。
//
// - 語彙段を先に置かないと、UI 文言まで Fontsource の 124 分割から引かれる。
//   実測でその経路は 474 KB（絞れば 123 KB）で、#386 の完了条件 500 KB を割る
// - 遅延段を system-ui より前に置かないと、地点名（Places API の任意の漢字）が
//   OS のフォントへ落ち、画面の中で書体が混ざる
//
// どちらも「動くが間違っている」形で出る——豆腐にならないので目視では気付けない。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { subsetFamily } from '../../vite/font-subset';

// 散文の中の family 名を規則だと読まないよう、コメントを先に落とす
// （test/theme/base-css.test.ts と同じ理由）。
const tokens = readFileSync('src/theme/tokens.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

const fontJp = /--font-jp:\s*([^;]+);/u.exec(tokens)?.[1] ?? '';

const families = fontJp
  .split(',')
  .map((name) => name.trim().replace(/^['"]|['"]$/gu, ''));

describe('--font-jp', () => {
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

  // 語彙段の family 名は vite/font-subset.ts が @font-face に書く名前と対になる。
  // 片方だけ変えても双方の単体テストは緑のまま、実ブラウザで当たらなくなる
  // （AppSettings.toJson と firestore.rules が同じ形の契約だった。#257）。
  it('語彙段の名前が @font-face 側と一致する', () => {
    expect(families).toContain(subsetFamily);
  });

  it('最後は総称ファミリで閉じる', () => {
    expect(families.at(-1)).toBe('sans-serif');
  });
});
