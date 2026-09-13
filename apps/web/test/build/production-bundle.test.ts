// 本番バンドルの中身でしか反証できない性質を、実際にビルドして確かめる。
//
// App Check のデバッグトークンはアテステーションのバイパスそのもので、持てば
// 課金プロキシを App Check 越しに叩ける（Firebase 自身が secret と呼ぶ）。開発でしか
// 読まないことは `if (import.meta.env.DEV)` の定数畳み込みに委ねているが、**それを
// 単体テストから観測する方法が無い**——vitest は dev 条件で走るため、畳み込みの結果を
// 見られない。
//
// 実際 PR #395 では2度取り違えた。1度目は `isDev` を引数にして分岐が畳めず、2度目は
// トークンを `appConfig` のプロパティに置いたため、分岐が消えても値だけが平文で残った
// （生きた export のプロパティは esbuild が落とさない）。どちらも `dist` を見るまで
// 気付けなかった。だからビルドを回す。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// vitest はブラウザ向けの import.meta.url を配るので、new URL(...) は file: にならない。
// この設定の `root`（= apps/web）から辿る。
const webRoot = resolve(dirname(fileURLToPath(`file://${__filename ?? ''}`)) || process.cwd(), '..', '..');

const debugTokenSentinel = 'DEBUG-TOKEN-SENTINEL-b3a1f0c2';
const proxySentinel = 'https://proxy-sentinel-9f2c.example';

let outDir: string;
let bundle: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'aruku-web-build-'));
  execFileSync(
    'npx',
    [
      'vite',
      'build',
      '--mode',
      'production',
      '--outDir',
      outDir,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        // vitest は NODE_ENV=test で走る。素通しすると `import.meta.env.DEV` が真の
        // まま畳まれ、**開発バンドルを検査して赤くなる**——製品ではなく治具の漏れ。
        NODE_ENV: 'production',
        VITE_PROXY_BASE_URL: proxySentinel,
        VITE_APP_CHECK_DEBUG_TOKEN: debugTokenSentinel,
      },
    },
  );

  const assets = join(outDir, 'assets');
  bundle = readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(assets, f), 'utf8'))
    .join('\n');
}, 120_000);

afterAll(() => {
  if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
});

describe('本番バンドル', () => {
  // これが無いと、ビルドが env を受け取っていないだけの「空振りで緑」を
  // 本物の安全と取り違える。
  // 真偽に畳んでから比べる。バンドルをそのまま渡すと、失敗時に数百 KB が
  // 差分として出て何も読めない。
  it('VITE_ の値はそもそもバンドルへ焼かれる（この検査が空振りでない証拠）', () => {
    expect(bundle.includes(proxySentinel)).toBe(true);
  });

  it('本番ビルドである（開発バンドルを検査して緑になっていない証拠）', () => {
    expect(bundle.includes('react-stack-top-frame')).toBe(false);
  });

  it('App Check のデバッグトークンを含まない', () => {
    expect(bundle.includes(debugTokenSentinel)).toBe(false);
  });

  // 書き込む側が残っていれば、トークンが別経路（グローバル直書き）で入り得る。
  it('デバッグトークンをグローバルへ書く分岐を含まない', () => {
    expect(/FIREBASE_APPCHECK_DEBUG_TOKEN\s*\]?\s*=[^=]/.test(bundle)).toBe(false);
  });
});
