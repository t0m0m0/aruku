import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/// エンジンのソースを直接解決する。tsconfig.json の `paths` と同じ対応を貼る
/// （型解決とバンドル解決が割れると、tsc は通るのに実行時だけ落ちる）。
const engineSrc = fileURLToPath(
  new URL('../../packages/engine/src', import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@aruku\/engine\/(.*)$/, replacement: `${engineSrc}/$1` }],
  },
  test: {
    include: ['test/**/*.test.ts'],

    // packages/engine/vitest.config.ts と同じ理由で固定する（naive JST 前提の
    // 時刻ロジックが実行環境の TZ でずれる）。エンジンを呼ぶ側も同じ壁時計で
    // 走らないと、境界の期待値が CI と手元で食い違う。
    env: { TZ: 'Asia/Tokyo' },
  },
});
