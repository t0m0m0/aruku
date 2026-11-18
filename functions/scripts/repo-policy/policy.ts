import ts from 'typescript';

export interface ForbiddenComment {
  readonly line: number;
  readonly text: string;
}

export type PolicyViolation =
  | { readonly kind: 'markdown'; readonly path: string }
  | {
      readonly kind: 'comment';
      readonly path: string;
      readonly line: number;
      readonly text: string;
    };

const PACKAGE_ROOTS = ['packages/engine/', 'apps/web/', 'functions/'] as const;
const CODE_EXTENSION = /\.(ts|tsx|mjs|cjs)$/;
const CONFIG_FILE = /\.config\.(ts|mts|cts|mjs|cjs)$/;
const JS_FILE = /\.(mjs|cjs)$/;
const GENERATED_FILES = new Set(['packages/engine/src/services/station-coord-table.ts']);

const ALLOWED_DIRECTIVES: readonly RegExp[] = [
  /^\/\/\s*(oxlint|eslint)-(disable|enable)(-next-line|-line)?(\s|$)/,
  /^\/\*\s*(oxlint|eslint)-(disable|enable)(-next-line|-line)?(\s[\s\S]*)?\*\/$/,
  /^\/\/\s*@ts-expect-error(\s|$)/,
  /^\/\/\/\s*<reference\s[^>]*\/>\s*$/,
  /^\/\*\s*@vite-ignore\s*\*\/$/,
  /^\/\/\s*@vitest-environment\s+\S+\s*$/,
];

const JSDOC_TYPE_TAGS: readonly RegExp[] = [
  /^@(type|returns?|satisfies)\s+\{.+\}$/,
  /^@(param|property|typedef)\s+\{.+\}\s+(\[[\w$.]+(=[^\]]*)?\]|[\w$.]+)$/,
  /^@template\s+[\w$]+(\s*,\s*[\w$]+)*$/,
];

const ALLOWED_MARKDOWN_FILES = new Set([
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'docs/security_hardening.md',
  'docs/archive/flutter-restore.md',
]);
const ALLOWED_MARKDOWN_DIRS = ['.claude/', '.codex/', '.agents/', 'docs/ops/'] as const;

export function isCommentPolicyTarget(path: string): boolean {
  if (!PACKAGE_ROOTS.some((root) => path.startsWith(root))) return false;
  if (GENERATED_FILES.has(path)) return false;
  return CODE_EXTENSION.test(path) && !CONFIG_FILE.test(path);
}

export function isAllowedMarkdown(path: string): boolean {
  return (
    ALLOWED_MARKDOWN_FILES.has(path) || ALLOWED_MARKDOWN_DIRS.some((dir) => path.startsWith(dir))
  );
}

function isJsDocTypeOnly(text: string): boolean {
  if (!text.startsWith('/**') || !text.endsWith('*/')) return false;
  const lines = text
    .slice(3, -2)
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^\*\s?/, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => JSDOC_TYPE_TAGS.some((tag) => tag.test(line)));
}

export function isAllowedComment(path: string, text: string): boolean {
  if (ALLOWED_DIRECTIVES.some((pattern) => pattern.test(text))) return true;
  return JS_FILE.test(path) && isJsDocTypeOnly(text);
}

function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isJsDocNode(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

function collectTokens(node: ts.Node, sourceFile: ts.SourceFile, tokens: ts.Node[]): void {
  const children = node.getChildren(sourceFile).filter((child) => !isJsDocNode(child));
  if (children.length === 0) {
    tokens.push(node);
    return;
  }
  for (const child of children) collectTokens(child, sourceFile, tokens);
}

const COMMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia,
]);

function commentsInTrivia(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): { pos: number; kind: ts.SyntaxKind; text: string }[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceFile.text,
    undefined,
    start,
    end - start,
  );
  const found: { pos: number; kind: ts.SyntaxKind; text: string }[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (COMMENT_KINDS.has(kind)) {
      found.push({ pos: scanner.getTokenStart(), kind, text: scanner.getTokenText() });
    }
  }
  return found;
}

export function findForbiddenComments(path: string, source: string): ForbiddenComment[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(path),
  );
  const tokens: ts.Node[] = [];
  collectTokens(sourceFile, sourceFile, tokens);

  const forbidden: ForbiddenComment[] = [];
  for (const token of tokens) {
    if (token.kind === ts.SyntaxKind.JsxText) continue;
    const start = token.getStart(sourceFile);
    for (const comment of commentsInTrivia(sourceFile, token.pos, start)) {
      if (comment.kind === ts.SyntaxKind.ShebangTrivia) continue;
      if (isAllowedComment(path, comment.text)) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(comment.pos);
      forbidden.push({ line: line + 1, text: comment.text });
    }
  }
  return forbidden;
}

export function findPolicyViolations(
  paths: readonly string[],
  read: (path: string) => string,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const path of paths) {
    if (path.endsWith('.md')) {
      if (!isAllowedMarkdown(path)) violations.push({ kind: 'markdown', path });
      continue;
    }
    if (!isCommentPolicyTarget(path)) continue;
    for (const comment of findForbiddenComments(path, read(path))) {
      violations.push({ kind: 'comment', path, ...comment });
    }
  }
  return violations;
}
