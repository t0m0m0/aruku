import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const webRoot = resolve(
  dirname(fileURLToPath(`file://${__filename}`)) || process.cwd(),
  '..',
  '..',
);

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
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
});

describe('本番バンドル', () => {
  it('VITE_ の値はそもそもバンドルへ焼かれる（この検査が空振りでない証拠）', () => {
    expect(bundle.includes(proxySentinel)).toBe(true);
  });

  it('本番ビルドである（開発バンドルを検査して緑になっていない証拠）', () => {
    expect(bundle.includes('react-stack-top-frame')).toBe(false);
  });

  it('App Check のデバッグトークンを含まない', () => {
    expect(bundle.includes(debugTokenSentinel)).toBe(false);
  });

  it('デバッグトークンをグローバルへ書く分岐を含まない', () => {
    expect(/FIREBASE_APPCHECK_DEBUG_TOKEN\s*\]?\s*=[^=]/.test(bundle)).toBe(false);
  });
});

describe('配信物の静的ファイル', () => {
  const distFiles = (): string[] => {
    const walk = (dir: string, prefix: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
      );
    return walk(outDir, '/');
  };

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

  it('開発時だけの A/B ベンチ画面を配らない', () => {
    expect(distFiles()).not.toContain('/bench.html');
    expect(bundle.includes('厳密走査 A/B ベンチ')).toBe(false);
  });

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

  it('全体規則に当たる要求へ Cache-Control を連結しない', () => {
    for (const [pattern, headers] of headerBlocks()) {
      if (pattern === '/assets/*') continue;
      expect(
        headers.join('\n'),
        `${pattern} の Cache-Control が /assets/* へ連結される`,
      ).not.toMatch(/Cache-Control/);
    }
  });

  it('マニフェストとアイコンを配る', () => {
    const files = distFiles();
    for (const path of [
      '/manifest.json',
      '/icon.svg',
      '/favicon.png',
      '/icons/apple-touch-icon.png',
      '/icons/Icon-192.png',
      '/icons/Icon-512.png',
      '/icons/Icon-maskable-192.png',
      '/icons/Icon-maskable-512.png',
    ]) {
      expect(files).toContain(path);
    }
  });

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
