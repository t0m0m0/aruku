import { describe, expect, it } from 'vitest';

import { collectVocabulary, collectVocabularyFromSources } from '../../vite/font-subset';

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
    const once = collectVocabularyFromSources([`'歩く歩く'`]);
    expect([...once].sort().join('')).toBe(once);
    expect(collectVocabularyFromSources([`'く歩'`])).toBe(once);
    expect(collectVocabularyFromSources([`'歩'`, `'く'`])).toBe(once);
  });

  it('文字列の中の // を行コメントの始まりと読まない', () => {
    const vocab = collectVocabularyFromSources([`const url = 'https://example.com/経路';`]);
    expect(vocab).toContain('経');
    expect(vocab).toContain('路');
  });

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
    const vocab = collectVocabularyFromSources([`const q = /['"]/u; const label = '出口';`]);
    for (const ch of '出口') expect(vocab).toContain(ch);
  });

  it('テンプレートリテラルの補間をまたいで拾う', () => {
    const vocab = collectVocabularyFromSources(['const s = `${dest} まで · 制限 ${budget}`;']);
    for (const ch of 'まで制限') expect(vocab).toContain(ch);
  });

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
  const vocab = collectVocabulary('.', ['../../packages/engine/src']);

  it('i18n の文言を拾う', () => {
    for (const ch of '経路を探す') expect(vocab).toContain(ch);
  });

  it('i18n の外にある描画文言も拾う', () => {
    for (const ch of '月日') expect(vocab).toContain(ch);
    for (const ch of 'まで制限') expect(vocab).toContain(ch);
  });

  it('index.html の meta description を拾う', () => {
    for (const ch of '「」電車乗時間内最大限歩ルト案案内') {
      expect(vocab).toContain(ch);
    }
  });

  it('エンジンが返す描画文言も拾う', () => {
    for (const ch of '時間分') expect(vocab).toContain(ch);
    for (const ch of '小田急東横線') expect(vocab).toContain(ch);
  });

  it('コメントに埋もれた漢字まで引き込まない', () => {
    expect(vocab.length).toBeLessThan(700);
  });
});
