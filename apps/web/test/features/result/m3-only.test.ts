import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = 'src/features/result';

const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => {
    const code = readFileSync(join(dir, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return [name, code] as const;
  });

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
  ['個別の太さ', cls('font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)')],
  ['直書きの角丸', cls('rounded(?:-[a-z]+)?-\\[[^\\]]+\\]')],
  ['M3 の段階でない角丸', cls('rounded(?:-[trblse]{1,2})?-(?:xs|sm|md|lg|[2-3]?xl)')],
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
