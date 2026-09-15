// 絞ったフォントを指す @font-face を組む。
//
// 分割の割り当ては自分で決めない。unicode-range が重なったとき、どの @font-face が
// 当たるかを決めるのは CSS の後勝ちで、本家 Fontsource の宣言順がそれを決めている。
// 文字ごとに「この塊へ入れる」と自前で割り振ると、本家が選ぶ塊とは別のものを絞って
// しまい、当たった側にグリフが無い＝豆腐になり得る。
//
// だから各 @font-face の unicode-range と語彙の**積**を取る形にする。本家が選ぶ塊が
// どれであれ、その塊は必ずその文字を持っている。

import { describe, expect, it } from 'vitest';

import {
  buildFontFaceCss,
  formatUnicodeRange,
  parseFontFaces,
  subsetPlan,
} from '../../vite/font-subset';

const fontsourceCss = `
/* noto-sans-jp-[119] */
@font-face {
  font-family: 'Noto Sans JP Variable';
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url(./files/noto-sans-jp-119-wght-normal.woff2) format('woff2-variations');
  unicode-range: U+3042,U+3044-3046,U+6B69;
}
/* noto-sans-jp-[latin] */
@font-face {
  font-family: 'Noto Sans JP Variable';
  src: url(./files/noto-sans-jp-latin-wght-normal.woff2) format('woff2-variations');
  unicode-range: U+0041-005A;
}
`;

describe('parseFontFaces', () => {
  it('ファイル名と unicode-range を宣言順に取り出す', () => {
    const faces = parseFontFaces(fontsourceCss);
    expect(faces.map((f) => f.file)).toEqual([
      'noto-sans-jp-119-wght-normal.woff2',
      'noto-sans-jp-latin-wght-normal.woff2',
    ]);
    expect(faces[0]!.ranges).toEqual([
      [0x3042, 0x3042],
      [0x3044, 0x3046],
      [0x6b69, 0x6b69],
    ]);
  });
});

describe('subsetPlan', () => {
  it('各 face の unicode-range と語彙の積を取る', () => {
    // あ(3042) い(3044) 歩(6B69) は 119 側、A(0041) は latin 側。
    // か(304B) はどちらの range にも無いので落ちる。
    const plan = subsetPlan(parseFontFaces(fontsourceCss), 'あい歩Aか');
    expect(plan).toEqual([
      { file: 'noto-sans-jp-119-wght-normal.woff2', chars: 'あい歩' },
      { file: 'noto-sans-jp-latin-wght-normal.woff2', chars: 'A' },
    ]);
  });

  it('語彙を1文字も含まない face は落とす（空のフォントを配らない）', () => {
    const plan = subsetPlan(parseFontFaces(fontsourceCss), 'A');
    expect(plan.map((p) => p.file)).toEqual([
      'noto-sans-jp-latin-wght-normal.woff2',
    ]);
  });

  // 重なった range の文字は両方へ入れる。どちらが当たっても持っている状態にする
  // ほうが、当たる側を自前で当てにいくより安い（重複は1グリフぶん）。
  it('range が重なる face には同じ文字を両方へ入れる', () => {
    const overlapping = `
@font-face { src: url(./files/a.woff2); unicode-range: U+3042; }
@font-face { src: url(./files/b.woff2); unicode-range: U+3042; }
`;
    const plan = subsetPlan(parseFontFaces(overlapping), 'あ');
    expect(plan).toEqual([
      { file: 'a.woff2', chars: 'あ' },
      { file: 'b.woff2', chars: 'あ' },
    ]);
  });
});

describe('formatUnicodeRange', () => {
  it('連続するコードポイントを範囲へ畳む', () => {
    // ぁ(3041) あ(3042) ぃ(3043) い(3044)。かな行は小書きと交互に並ぶので、
    // 「あいうえ」は連続していない（3042,3044,3046,3048）。
    expect(formatUnicodeRange('ぁあぃい')).toBe('U+3041-3044');
  });

  it('飛んだコードポイントは別項目にする', () => {
    expect(formatUnicodeRange('あ歩')).toBe('U+3042,U+6B69');
  });
});

describe('buildFontFaceCss', () => {
  const css = buildFontFaceCss([
    { family: 'Noto Sans JP Subset', url: '/assets/a.woff2', chars: 'ぁあ' },
  ]);

  it('可変フォントの軸をそのまま宣言する', () => {
    // 使う側は 500/600/700/800 の4段を引く。1つの可変フォントで全部賄うので、
    // 重みごとにファイルを持たない。
    expect(css).toContain('font-weight: 100 900');
    expect(css).toContain("format('woff2-variations')");
  });

  it('語彙ちょうどの unicode-range を宣言する', () => {
    // 宣言しないと、語彙外の文字でもこのフォントが当たってしまい、
    // 遅延段（Fontsource）へ落ちずに豆腐になる。
    expect(css).toContain('unicode-range: U+3041-3042');
  });

  it('描画をブロックしない', () => {
    expect(css).toContain('font-display: swap');
  });

  it('指定した family 名で宣言する', () => {
    expect(css).toContain("font-family: 'Noto Sans JP Subset'");
  });
});
