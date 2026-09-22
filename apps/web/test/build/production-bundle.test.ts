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

// 配信物に載る静的ファイル（`public/`）の検査もここへ置く。上と同じ `dist` を
// 使い回すためで、別ファイルに分けるとこの 60 秒のビルドがもう1回走る。
//
// バンドルと違い、こちらは Cloudflare Pages の配信規則との噛み合わせを見る。
// どれも `vite build` は成功したまま壊れ、配信してからしか現れない。
describe('配信物の静的ファイル', () => {
  const distFiles = (): string[] => {
    const walk = (dir: string, prefix: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name), `${prefix}${e.name}/`)
          : [`${prefix}${e.name}`],
      );
    return walk(outDir, '/');
  };

  /// `_headers` をパターン → ヘッダ行の対応へ解く。
  ///
  /// 正規表現でブロックを切り出そうとすると、`/*` の見出し自身をブロックの区切りと
  /// 読んでしまい、**全体規則の中身を一度も見ないまま緑になる**（実際に一度そう書いて、
  /// 退行を入れても赤くならないことで気付いた）。行を順に畳む形にする。
  const headerBlocks = (): Map<string, string[]> => {
    const blocks = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const raw of readFileSync(join(outDir, '_headers'), 'utf8').split('\n')) {
      const line = raw.replace(/#.*$/, '');
      if (line.trim() === '') continue;
      if (/^\S/.test(line)) {
        current = [];
        blocks.set(line.trim(), current);
      } else {
        current?.push(line.trim());
      }
    }
    return blocks;
  };

  // Pages は `404.html` が無いときだけ「SPA を配っている」と見なし、どのファイルにも
  // 当たらないパスを `/` へ回す。`createBrowserRouter` は実パスを使うので、
  // これが無いと /home/search のリロードと外からの deep link が全部 404 になる。
  //
  // **`_redirects` で明示しようとしてはいけない。** `/* /index.html 200` は
  // 「Redirects are always followed, regardless of whether or not an asset matches
  // the incoming request」（Cloudflare Pages のドキュメント）に当たり、
  // /assets/*.js まで index.html に差し替わってサイトごと壊れる。
  //
  // この振る舞いは E2E では反証できない——Playwright は `vite preview` 相手に走り、
  // あちらは自前で SPA フォールバックするので `404.html` の有無に関係なく緑になる。
  // 成果物を見るこの検査が唯一の歯止め。
  it('404.html を作らない（Pages の SPA フォールバックを殺さないため）', () => {
    expect(distFiles()).not.toContain('/404.html');
  });

  it('セキュリティヘッダを全体へ配る', () => {
    expect(headerBlocks().get('/*')).toEqual([
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: strict-origin-when-cross-origin',
      'X-Frame-Options: DENY',
    ]);
  });

  it('ハッシュ付きの資産だけを長期キャッシュにする', () => {
    expect(headerBlocks().get('/assets/*')?.join('\n')).toMatch(/Cache-Control:.*immutable/);
  });

  // Pages は「複数の規則に当たった要求は全部の規則のヘッダを継ぐ」規則で、同名の
  // ヘッダは**上書きではなくカンマ連結**される（Cloudflare Pages のドキュメント）。
  // `/*` に Cache-Control を置くと、それが /assets/* にも連結されて
  // `no-cache, public, max-age=31536000, immutable` になり、immutable が死ぬ。
  // 既定（`public, max-age=0, must-revalidate` + ETag）が既に毎回再検証なので、
  // index.html 側に規則を足す必要はない。
  it('全体規則に当たる要求へ Cache-Control を連結しない', () => {
    for (const [pattern, headers] of headerBlocks()) {
      if (pattern === '/assets/*') continue;
      expect(headers.join('\n'), `${pattern} の Cache-Control が /assets/* へ連結される`)
        .not.toMatch(/Cache-Control/);
    }
  });

  it('マニフェストとアイコンを配る', () => {
    const files = distFiles();
    for (const path of [
      '/manifest.json',
      '/favicon.png',
      '/icons/Icon-192.png',
      '/icons/Icon-512.png',
      '/icons/Icon-maskable-192.png',
      '/icons/Icon-maskable-512.png',
    ]) {
      expect(files).toContain(path);
    }
  });

  // 移植元の `_headers` は `flutter_bootstrap.js` / `flutter_service_worker.js` /
  // `version.json` を名指ししていた。そのまま引き継ぐと、存在しないパスへの規則が
  // 残ったまま**何も壊れない**——当たらない規則は黙って無視されるだけなので、
  // 意図した規則が効いていない状態と見分けが付かない。
  it('_headers のパス規則はすべて配信物に当たる', () => {
    const files = distFiles();
    const patterns = [...headerBlocks().keys()];

    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const matched = pattern.includes('*')
        ? files.some((f) => f.startsWith(pattern.slice(0, pattern.indexOf('*'))))
        : files.includes(pattern);
      expect(matched, `${pattern} に当たる配信物が無い`).toBe(true);
    }
  });
});
