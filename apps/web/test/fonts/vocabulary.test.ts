// 同梱するフォントは「この画面が実際に描く文字」ちょうどへ絞る。絞りすぎれば豆腐が
// 出るし、緩めれば #386 の完了条件（初回ロード gzip 500 KB 未満）を割る。
//
// 危ないのは緩い側ではなく厳しい側——豆腐は描かれて初めて見え、描かれるのは
// エラー画面のように滅多に出ない経路だったりする。だから「拾い漏らさない」ほうを
// 反証する。

import { describe, expect, it } from 'vitest';

import {
  collectVocabulary,
  collectVocabularyFromSources,
} from '../../vite/font-subset';

describe('collectVocabularyFromSources', () => {
  it('文字列リテラルの中身を拾う', () => {
    const vocab = collectVocabularyFromSources([
      `const label = '出発';`,
      `const other = "到着";`,
      'const tpl = `経由`;',
    ]);
    for (const ch of '出発到着経由') expect(vocab).toContain(ch);
  });

  it('コメントの中身は拾わない', () => {
    const vocab = collectVocabularyFromSources([
      `// 遅延の理由をここに書く\nconst ok = '可';`,
      `/* 混雑 */\nconst ng = '否';`,
    ]);
    expect(vocab).toContain('可');
    expect(vocab).toContain('否');
    for (const ch of '遅延理由書混雑') expect(vocab).not.toContain(ch);
  });

  it('重複を畳み、入力の並びによらず同じ語彙になる', () => {
    // 並びが入力依存だと、無関係な編集でフォントのハッシュが変わり、
    // 利用者のキャッシュが理由なく落ちる。
    const once = collectVocabularyFromSources([`'歩く歩く'`]);
    expect([...once].sort().join('')).toBe(once);
    expect(collectVocabularyFromSources([`'く歩'`])).toBe(once);
    expect(collectVocabularyFromSources([`'歩'`, `'く'`])).toBe(once);
  });

  // コメントを正規表現で先に落とす実装は、ここで落ちる。
  it('文字列の中の // を行コメントの始まりと読まない', () => {
    const vocab = collectVocabularyFromSources([
      `const url = 'https://example.com/経路';`,
    ]);
    expect(vocab).toContain('経');
    expect(vocab).toContain('路');
  });

  it('正規表現リテラルの中の引用符で状態を崩さない', () => {
    const vocab = collectVocabularyFromSources([
      `const q = /['"]/u; const label = '出口';`,
    ]);
    for (const ch of '出口') expect(vocab).toContain(ch);
  });

  it('テンプレートリテラルの補間をまたいで拾う', () => {
    const vocab = collectVocabularyFromSources([
      'const s = `${dest} まで · 制限 ${budget}`;',
    ]);
    for (const ch of 'まで制限') expect(vocab).toContain(ch);
  });

  it('空白と制御文字は落とす（グリフを持たない）', () => {
    const vocab = collectVocabularyFromSources([`'あ い\tう\nえ'`]);
    expect(vocab).toBe('あいうえ');
  });
});

describe('collectVocabulary', () => {
  const vocab = collectVocabulary('.');

  it('i18n の文言を拾う', () => {
    for (const ch of '経路を探す') expect(vocab).toContain(ch);
  });

  // 語彙を i18n/ja.ts だけから集める実装は、ここだけが赤くなる形で壊れる。
  // 描画される日本語はテンプレートリテラルの形で他のモジュールにも散っている。
  it('i18n の外にある描画文言も拾う', () => {
    // src/i18n/format.ts の `${月}${日}`
    for (const ch of '月日') expect(vocab).toContain(ch);
    // src/features/loading/loading-screen.tsx の「まで · 制限」
    for (const ch of 'まで制限') expect(vocab).toContain(ch);
  });

  it('コメントに埋もれた漢字まで引き込まない', () => {
    // 移植メモの散文は全ソースに渡って厚い。拾うと語彙が3倍に膨らみ、
    // 絞る意味が消える（実測: 289 文字 → 919 文字）。
    expect(vocab.length).toBeLessThan(600);
  });
});
