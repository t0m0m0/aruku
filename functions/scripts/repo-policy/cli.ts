import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPolicyViolations, type PolicyViolation } from './policy.ts';

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function trackedPaths(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0').filter((path) => path.length > 0);
}

function describe(violation: PolicyViolation): string {
  if (violation.kind === 'markdown') {
    return `${violation.path}: 許可リストに無い Markdown`;
  }
  return `${violation.path}:${violation.line}: コメント ${violation.text.split('\n')[0]}`;
}

const root = repoRoot();
const violations = findPolicyViolations(trackedPaths(root), (path) =>
  readFileSync(join(root, path), 'utf8'),
);

if (violations.length > 0) {
  for (const violation of violations) console.error(describe(violation));
  console.error(`\n${violations.length} 件の違反（コメントと Markdown の禁止、#528）`);
  process.exit(1);
}
