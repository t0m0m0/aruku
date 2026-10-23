// 結果画面は Material 3 のトークン（src/theme/tokens.css の色の役割・文字の段階・角丸の段階）
// だけで描く（#455）。jsdom は CSS を読まないので、描画からは検査できない——ソースの
// クラス名を見る。
//
// 他の画面はまだ旧トークン（moss / ink / paper …）で描いており、トークン自体は残っている。
// ここが落ちるのは、結果画面に旧い書き方が戻ったとき。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = 'src/features/result';

const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => {
    // 決定を説明している散文の中の語（「moss 系」など）を拾わないよう、コメントを落とす。
    const code = readFileSync(join(dir, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return [name, code] as const;
  });

// クラス名の前に付く修飾（`desktop:` `hover:` など）は問わない。
const cls = (body: string) => new RegExp(`(?<![\\w-])(?:[\\w-]+:)*${body}(?![\\w-])`, 'gu');

const forbidden: [string, RegExp][] = [
  [
    '旧パレットの色',
    cls(
      '(?:bg|text|border|border-[lrtbxy]|ring|fill|stroke|outline|divide)-(?:moss|ink|ivory|paper|sand|hairline|walk|train|burnt|danger|gold)(?:-[\\w/]+)?',
    ),
  ],
  [
    'shadcn の意味的な色（M3 の役割名で書く）',
    cls(
      '(?:bg|text|border|ring)-(?:background|foreground|card|popover|secondary|muted|accent|destructive|border|input)(?:-foreground)?(?:/\\d+)?',
    ),
  ],
  ['px 直書きの文字サイズ', cls('text-\\[[^\\]]+\\]')],
  ['Tailwind 既定の文字サイズ', cls('text-(?:xs|sm|base|lg|[2-9]?xl)')],
  // 太さは文字の段階が持つ。個別に足すと段階の意味が崩れる。
  ['個別の太さ', cls('font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)')],
  ['直書きの角丸', cls('rounded(?:-[a-z]+)?-\\[[^\\]]+\\]')],
  ['M3 の段階でない角丸', cls('rounded(?:-[trblse]{1,2})?-(?:xs|sm|md|lg|[2-3]?xl)')],
  // 浮く物（ボトムシート等）だけが影を持つ。結果画面には無い。
  ['影', cls('shadow(?:-[\\w-]+)?')],
];

describe.each(sources)('%s', (_name, code) => {
  it.each(forbidden)('%sを使っていない', (_label, pattern) => {
    expect(code.match(pattern) ?? []).toEqual([]);
  });
});

it('結果画面のソースを読めている', () => {
  expect(sources.map(([name]) => name)).toEqual(
    expect.arrayContaining(['result-screen.tsx', 'result-timeline.tsx']),
  );
});
