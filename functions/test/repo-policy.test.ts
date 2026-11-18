import { describe, expect, it } from 'vitest';
import {
  findForbiddenComments,
  findPolicyViolations,
  isAllowedMarkdown,
  isCommentPolicyTarget,
} from '../scripts/repo-policy/policy';

function texts(path: string, source: string): string[] {
  return findForbiddenComments(path, source).map((c) => c.text);
}

describe('isCommentPolicyTarget', () => {
  it.each([
    'packages/engine/src/route.ts',
    'apps/web/src/features/home/Home.tsx',
    'apps/web/scripts/replay.mjs',
    'functions/src/index.ts',
    'functions/test/rate-limit.test.ts',
    'packages/engine/scripts/station-coord-corrections.mjs',
    'apps/web/src/legacy.cjs',
  ])('3パッケージのコード %s は検査する', (path) => {
    expect(isCommentPolicyTarget(path)).toBe(true);
  });

  it.each([
    'apps/web/vite.config.ts',
    'apps/web/playwright.config.ts',
    'functions/vitest.config.ts',
    'functions/vitest.rules.config.ts',
    'packages/engine/vitest.config.ts',
  ])('設定ファイル %s は検査しない', (path) => {
    expect(isCommentPolicyTarget(path)).toBe(false);
  });

  it('生成物は検査しない', () => {
    expect(isCommentPolicyTarget('packages/engine/src/services/station-coord-table.ts')).toBe(
      false,
    );
  });

  it.each([
    '.dependency-cruiser.cjs',
    'knip.jsonc',
    '.oxlintrc.json',
    'functions/.oxlintrc.json',
    'apps/web/index.html',
    'apps/web/src/theme/tokens.css',
    'docs/ops/replay-bench.md',
    'other/src/index.ts',
  ])('3パッケージの外やコード以外の %s は検査しない', (path) => {
    expect(isCommentPolicyTarget(path)).toBe(false);
  });
});

describe('findForbiddenComments', () => {
  it('行コメントとブロックコメントと JSDoc を拒否する', () => {
    const source = [
      '// 行コメント',
      '/* ブロック */',
      '/** JSDoc */',
      'export const a = 1; // 行末',
      '',
    ].join('\n');
    expect(texts('functions/src/a.ts', source)).toEqual([
      '// 行コメント',
      '/* ブロック */',
      '/** JSDoc */',
      '// 行末',
    ]);
  });

  it('拒否したコメントの行番号を1始まりで返す', () => {
    const source = 'const a = 1;\n\n// ここ\nconst b = 2;\n';
    expect(findForbiddenComments('functions/src/a.ts', source)).toEqual([
      { line: 3, text: '// ここ' },
    ]);
  });

  it('空のブロックや閉じ括弧の前、ファイル末尾のコメントも拒否する', () => {
    const source = [
      'function f() {',
      '  // 空の本体',
      '}',
      'const xs = [',
      '  1,',
      '  // 閉じ括弧の前',
      '];',
      '// 末尾',
    ].join('\n');
    expect(texts('functions/src/a.ts', source)).toEqual([
      '// 空の本体',
      '// 閉じ括弧の前',
      '// 末尾',
    ]);
  });

  it('文字列・テンプレート・正規表現の中のコメント記号はコメントではない', () => {
    const source = [
      "const url = 'https://example.com/*';",
      'const t = `a // b /* c */ ${url} // d`;',
      'const r = /\\/\\/ x/;',
      '',
    ].join('\n');
    expect(texts('functions/src/a.ts', source)).toEqual([]);
  });

  it('JSX のテキストに書かれたコメント記号はコメントではない', () => {
    const source = [
      'export const A = () => (',
      '  <p>',
      '    see https://example.com // not a comment /* nor this */',
      '  </p>',
      ');',
      '',
    ].join('\n');
    expect(texts('apps/web/src/A.tsx', source)).toEqual([]);
  });

  it('JSX の式コンテナに書いたコメントは拒否する', () => {
    const source = [
      'export const A = () => (',
      '  <div>',
      '    {/* JSX のコメント */}',
      '    <span>x</span>',
      '  </div>',
      ');',
      '',
    ].join('\n');
    expect(texts('apps/web/src/A.tsx', source)).toEqual(['/* JSX のコメント */']);
  });

  it.each([
    '// oxlint-disable-next-line typescript/no-explicit-any',
    '// oxlint-disable-next-line no-console -- 理由',
    '/* oxlint-disable no-console */',
    '// eslint-disable-next-line react-hooks/exhaustive-deps',
    '// @ts-expect-error 型定義が古い',
    '/// <reference types="vite/client" />',
    ['//', ['@vitest', 'environment'].join('-'), 'jsdom'].join(' '),
  ])('ツールが読むディレクティブ %s は許す', (directive) => {
    const source = `${directive}\nexport const a: number = 1;\n`;
    expect(texts('apps/web/src/a.ts', source)).toEqual([]);
  });

  it('import() に添える /* @vite-ignore */ は許す', () => {
    const source = 'export const load = (p: string) => import(/* @vite-ignore */ p);\n';
    expect(texts('apps/web/src/a.ts', source)).toEqual([]);
  });

  it('shebang は許す', () => {
    const source = '#!/usr/bin/env node\nconsole.log(1);\n';
    expect(texts('apps/web/scripts/a.mjs', source)).toEqual([]);
  });

  it('ディレクティブの語を含むだけの説明コメントは拒否する', () => {
    const source = [
      '// ここで oxlint-disable を使わない理由',
      '// TODO: @ts-expect-error を外す',
      '/* @vite-ignore を付けると警告が消える */',
      '',
    ].join('\n');
    expect(texts('apps/web/src/a.ts', source)).toEqual([
      '// ここで oxlint-disable を使わない理由',
      '// TODO: @ts-expect-error を外す',
      '/* @vite-ignore を付けると警告が消える */',
    ]);
  });

  it('.mjs と .cjs も検査する', () => {
    expect(texts('apps/web/scripts/a.mjs', '// x\nexport {};\n')).toEqual(['// x']);
    expect(texts('apps/web/scripts/a.cjs', '// y\nmodule.exports = {};\n')).toEqual(['// y']);
  });
});

describe('findForbiddenComments の JSDoc 型', () => {
  it.each([
    '/** @type {unknown[]} */',
    '/** @param {string} path */',
    '/** @type {Map<string, { lat: number, lon: number }[]>} */',
    "/** @type {typeof import('../src/bench/replay/replay-cli.ts')} */",
    ['/**', ' * @param {unknown} v', ' * @returns {v is Record<string, unknown>}', ' */'].join(
      '\n',
    ),
    [
      '/**',
      ' * @template T',
      ' * @param {T[]} xs',
      ' * @param {number} [n]',
      ' * @returns {T}',
      ' */',
    ].join('\n'),
    '/** @typedef {{ a: number }} Pair */',
  ])('.mjs の型だけの JSDoc %s は許す', (jsdoc) => {
    const source = `${jsdoc}\nexport const f = (v) => v;\n`;
    expect(texts('apps/web/scripts/a.mjs', source)).toEqual([]);
    expect(texts('apps/web/scripts/a.cjs', source)).toEqual([]);
  });

  it.each([
    ['/**', ' * 値を整える', ' * @param {string} v', ' */'].join('\n'),
    '/** @param {string} v 整える対象 */',
    '/** @returns {string} 整えた値 */',
    '/** 型の説明 */',
    '/* @type {string} */',
    '// @type {string}',
  ])('説明を含む・JSDoc でない %s は拒否する', (comment) => {
    const source = `${comment}\nexport const f = (v) => v;\n`;
    expect(texts('apps/web/scripts/a.mjs', source)).toEqual([comment]);
  });

  it('TypeScript では型だけの JSDoc も拒否する', () => {
    const source = '/** @param {string} v */\nexport const f = (v: string) => v;\n';
    expect(texts('apps/web/src/a.ts', source)).toEqual(['/** @param {string} v */']);
  });
});

describe('isAllowedMarkdown', () => {
  it.each([
    'README.md',
    'CLAUDE.md',
    'AGENTS.md',
    '.claude/docs/workflow.md',
    '.claude/agents/reviewer.md',
    '.codex/commands/auto-issue.md',
    '.agents/skills/brandkit/SKILL.md',
    'docs/ops/replay-bench.md',
    'docs/ops/new-runbook.md',
    'docs/security_hardening.md',
    'docs/archive/flutter-restore.md',
  ])('%s は許す', (path) => {
    expect(isAllowedMarkdown(path)).toBe(true);
  });

  it.each([
    'docs/spec/route-optimization.md',
    'docs/notes/exact-scan-one-transfer.md',
    'docs/archive/other.md',
    'docs/new.md',
    'apps/web/PORTING.md',
    'packages/engine/PORTING.md',
    'apps/web/README.md',
    'functions/src/NOTES.md',
  ])('%s は許さない', (path) => {
    expect(isAllowedMarkdown(path)).toBe(false);
  });
});

describe('findPolicyViolations', () => {
  it('許可リストに無い Markdown と、検査対象のコードのコメントを列挙する', () => {
    const files: Record<string, string> = {
      'README.md': '# aruku\n',
      'docs/spec/route-optimization.md': '# spec\n',
      'functions/src/a.ts': 'export const a = 1;\n// 説明\n',
      'functions/src/b.ts': 'export const b = 1;\n',
      'functions/vitest.config.ts': '// 設定のコメント\nexport default {};\n',
      '.dependency-cruiser.cjs': '// 設定のコメント\nmodule.exports = {};\n',
    };
    const violations = findPolicyViolations(Object.keys(files), (path) => files[path] ?? '');
    expect(violations).toEqual([
      { kind: 'markdown', path: 'docs/spec/route-optimization.md' },
      { kind: 'comment', path: 'functions/src/a.ts', line: 2, text: '// 説明' },
    ]);
  });

  it('コードでも Markdown でもないファイルは読まない', () => {
    const read: string[] = [];
    findPolicyViolations(['apps/web/index.html', 'functions/package.json'], (path) => {
      read.push(path);
      return '';
    });
    expect(read).toEqual([]);
  });
});
