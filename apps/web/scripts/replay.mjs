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

const tag = createHash('sha1').update(engineDir).digest('hex').slice(0, 10);
const outDir = resolve(appDir, '.replay/build', tag);

await build({
  root: appDir,
  configFile: false,
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

/** @type {typeof import('../src/bench/replay/replay-cli.ts')} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const cli = await import(pathToFileURL(resolve(outDir, 'replay-cli.mjs')).href);
process.exitCode = await cli.main(harnessArgs);
