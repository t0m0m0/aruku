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

  // `.tsx` の閉じタグ `</span>` は `<` の直後に `/` が来る。ここを正規表現の
  // 始まりと読むと、次の `/` まで走査が飛び、その間の文字列リテラルが丸ごと
  // 語彙から落ちる（PR #403 の Codex 指摘。result-timeline.tsx の「→」が実際に
  // 落ちていた）。自己終了タグ `/>` も直前が `}` や `"` になる。
  it('JSX の閉じタグを正規表現の始まりと読まない', () => {
    const vocab = collectVocabularyFromSources([
      `const el = <span>{\`\${a} → \${b}\`}</span>; const label = '区間';`,
    ]);
    expect(vocab).toContain('→');
    for (const ch of '区間') expect(vocab).toContain(ch);
  });

  it('JSX の自己終了タグを正規表現の始まりと読まない', () => {
    const vocab = collectVocabularyFromSources([
      `const el = <Foo bar={baz} />; const label = '徒歩';`,
    ]);
    for (const ch of '徒歩') expect(vocab).toContain(ch);
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

  // 空白を「グリフが要らない文字」として落とすと、語彙段が U+0020 を覆わなくなる。
  // ブラウザは空白を描くためのフォントを次の family へ探しに行き、遅延段の
  // latin（12 KB）と 117（80 KB）を引く——空白1文字のために 92 KB。
  // 実ブラウザの network で確認した。描画は成立するので目視では見えない。
  it('描かれる空白は残す（次の family を引かせない）', () => {
    const vocab = collectVocabularyFromSources([`'あ い'`]);
    expect(vocab).toContain(' ');
  });

  it('改行とタブは落とす（ソースの整形であって描かれない）', () => {
    const vocab = collectVocabularyFromSources([`'あ\tい\nう'`]);
    expect(vocab).not.toContain('\t');
    expect(vocab).not.toContain('\n');
    expect(vocab).toBe('あいう');
  });

  it('制御文字は落とす', () => {
    const vocab = collectVocabularyFromSources([`'あ\u0000い'`]);
    expect(vocab).toBe('あい');
  });
});

describe('collectVocabulary', () => {
  // エンジンは alias でソース直参照され、同じバンドルへ入る（vite.config.ts）。
  // つまりエンジンの文字列リテラルは apps/web 自身のものと同じだけ「描かれる」。
  const vocab = collectVocabulary('.', ['../../packages/engine/src']);

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

  // index.html の日本語は `<meta name="description">` の content 属性の中にしかない。
  // タグを丸ごと落とす実装だと属性値ごと消え、ここだけが語彙から抜ける。
  // 抜けると、ブラウザはこの文字列のために遅延段の 80 KB を引く（実ブラウザで確認）。
  it('index.html の meta description を拾う', () => {
    for (const ch of '「」電車乗時間内最大限歩ルト案案内') {
      expect(vocab).toContain(ch);
    }
  });

  // エンジンを走査しない実装は、ここだけが赤くなる形で壊れる。
  // TimeValue.dateLabel() は「明日」を返し、time-field.tsx がそれを描く。
  // 抜けても豆腐にはならず、遅延段が 80 KB 級の塊を引いて正しく描いてしまう。
  it('エンジンが返す描画文言も拾う', () => {
    for (const ch of '明日') expect(vocab).toContain(ch);
    // TimeValue.formatDuration() の「時間」「分」
    for (const ch of '時間分') expect(vocab).toContain(ch);
    // rail-line-names.ts の路線名（東急東横線 など）
    for (const ch of '小田急東横線') expect(vocab).toContain(ch);
  });

  it('コメントに埋もれた漢字まで引き込まない', () => {
    // 移植メモの散文は全ソースに渡って厚い。拾うと語彙が膨らみ、絞る意味が
    // 薄れる（実測: 431 文字 → 1,105 文字）。
    expect(vocab.length).toBeLessThan(700);
  });
});
