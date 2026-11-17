// Transit 応答の録画・再生ハーネス（#504）を、指定した版のエンジンで束ねて走らせる。
//
//   node scripts/replay.mjs [--engine <packages/engine のパス>] -- --store <rec.json> \
//     --out <out.jsonl> --date 2026-11-16 [--ratios 1.2,1.5,2] [--slots 12:00] ...
//
// `--` より後ろはハーネスの引数（src/bench/replay/replay-args.ts）。手順は
// docs/ops/replay-bench.md。
//
// tsx などを足さず、apps/web が持つ vite の SSR ビルドで束ねる。Node の型除去だけでは
// `@aruku/engine/*` の別名と `import.meta.env` を解けないため。

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'vite';

process.env.TZ = 'Asia/Tokyo';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep < 0 ? [] : argv.slice(0, sep);
const harnessArgs = sep < 0 ? argv : argv.slice(sep + 1);

let engineDir = resolve(appDir, '../../packages/engine');
for (let i = 0; i < own.length; i += 2) {
  const value = own.at(i + 1);
  if (own[i] === '--engine' && value !== undefined) {
    engineDir = resolve(value);
  } else {
    console.error(`unknown argument: ${own[i]}`);
    process.exit(2);
  }
}

// 比べる版ごとに出力先を分ける。並列に回す別の版のビルドが、同じファイルを上書きしないため。
const tag = createHash('sha1').update(engineDir).digest('hex').slice(0, 10);
const outDir = resolve(appDir, '.replay/build', tag);

await build({
  root: appDir,
  configFile: false,
  // apps/web/.env を読まない。vite は VITE_* をビルド時に文字列へ焼くので、読めば
  // 開発用の値がこの出力に残る。ハーネスは環境変数の設定を使わない。
  envDir: false,
  publicDir: false,
  logLevel: 'warn',
  resolve: {
    alias: [{ find: /^@aruku\/engine\/(.*)$/, replacement: `${engineDir}/src/$1` }],
  },
  build: {
    ssr: 'src/bench/replay/replay-cli.ts',
    outDir,
    emptyOutDir: true,
    minify: false,
    rolldownOptions: { output: { entryFileNames: 'replay-cli.mjs' } },
  },
});

// 束ねたばかりの出力には型が無い。中身はビルド元の replay-cli.ts そのものなので、その型で受ける。
/** @type {typeof import('../src/bench/replay/replay-cli.ts')} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const cli = await import(pathToFileURL(resolve(outDir, 'replay-cli.mjs')).href);
process.exitCode = await cli.main(harnessArgs);
