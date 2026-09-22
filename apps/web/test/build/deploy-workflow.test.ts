// `deploy-web.yml` と `src/` は同じ契約の両端にある。ワークフローが渡す名前と
// アプリが読む名前は別々に書かれるので食い違い得るが、**食い違っても何も落ちない**
// ——Vite は知らない env を黙って捨て、`import.meta.env.VITE_X` は undefined になり、
// `?? ''` が空文字へ丸める。ビルドも型検査も通り、配信してから「地図が出ない」
// 「検索が 401」という原因の遠い形で出る。移植元が dart-define でぶつかっていたのと
// 同じ問題で、あちらは「Verify required configuration」ステップで空値だけを見ていた
// ——名前の取り違え（`VITE_` の付け忘れ）はそこを素通りする。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const webRoot = resolve(
  dirname(fileURLToPath(`file://${__filename ?? ''}`)) || process.cwd(),
  '..',
  '..',
);
const repoRoot = resolve(webRoot, '..', '..');

const workflow = readFileSync(
  join(repoRoot, '.github/workflows/deploy-web.yml'),
  'utf8',
);

/// `src/` 全体が読む `import.meta.env.VITE_*` の名前。
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

/// ワークフローが build ジョブへ渡す `VITE_*` の名前。
const namesSetByWorkflow = (): Set<string> =>
  new Set(
    [...workflow.matchAll(/^\s+(VITE_[A-Z0-9_]+):/gm)].map((m) => m[1]),
  );

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

  // これは秘密で、本番バンドルへ焼かれてはならない（production-bundle.test.ts）。
  // 渡さないことをここでも見るのは、あちらが「バンドルに無い」しか見ていないため
  // ——ワークフローで渡し始めても、分岐が畳まれている限りあちらは緑のままになる。
  it('App Check のデバッグトークンは渡さない', () => {
    expect([...namesSetByWorkflow()]).not.toContain(
      'VITE_APP_CHECK_DEBUG_TOKEN',
    );
  });

  // 空値検査のリストと env ブロックが割れると、渡しているのに検査されない値が出る。
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
