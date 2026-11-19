import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const webRoot = resolve(
  dirname(fileURLToPath(`file://${__filename}`)) || process.cwd(),
  '..',
  '..',
);
const repoRoot = resolve(webRoot, '..', '..');

const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy-web.yml'), 'utf8');

const namesReadByApp = (): Set<string> => {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      for (const m of readFileSync(path, 'utf8').matchAll(
        /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g,
      )) {
        found.add(m[1]);
      }
    }
  };
  walk(join(webRoot, 'src'));
  return found;
};

const namesSetByWorkflow = (): Set<string> =>
  new Set([...workflow.matchAll(/^\s+(VITE_[A-Z0-9_]+):/gm)].map((m) => m[1]));

describe('deploy-web.yml とアプリの設定', () => {
  it('ワークフローが渡す名前はすべてアプリが読む', () => {
    const read = namesReadByApp();
    for (const name of namesSetByWorkflow()) {
      expect([...read], `${name} を読む箇所が src/ に無い`).toContain(name);
    }
  });

  it('#387 が移すと決めた5つを渡す', () => {
    const set = namesSetByWorkflow();
    for (const name of [
      'VITE_FIREBASE_WEB_API_KEY',
      'VITE_FIREBASE_WEB_APP_ID',
      'VITE_RECAPTCHA_SITE_KEY',
      'VITE_MAPS_WEB_API_KEY',
      'VITE_PROXY_BASE_URL',
    ]) {
      expect([...set]).toContain(name);
    }
  });

  it('本番では厳密走査を有効にする (#477)', () => {
    expect(workflow).toMatch(/^\s+VITE_EXACT_WALK_MAX: '1'$/m);
  });

  it('App Check のデバッグトークンは渡さない', () => {
    expect([...namesSetByWorkflow()]).not.toContain('VITE_APP_CHECK_DEBUG_TOKEN');
  });

  it('空値検査のリストは渡す名前と一致する', () => {
    const verified = new Set(
      workflow
        .slice(workflow.indexOf('for name in '))
        .slice(0, workflow.slice(workflow.indexOf('for name in ')).indexOf(';'))
        .match(/VITE_[A-Z0-9_]+/g) ?? [],
    );
    expect([...verified].sort()).toEqual([...namesSetByWorkflow()].sort());
  });
});
