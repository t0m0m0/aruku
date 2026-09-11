import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],

    // タイムゾーンを固定する。移植元の Dart テストは端末ローカルの `DateTime` で
    // 書かれており（`transitSecsToJst` の naive JST 前提・#121）、実行環境の TZ が
    // 変わると期待値の壁時計がずれる。CI（UTC）と手元（JST）で違う結果になるのを
    // 防ぐと同時に、UTC で走らせると「UTC で作った日時」と「ローカルで作った日時」が
    // 一致してしまい、naive であることを検証するテストが素通りする。
    env: { TZ: 'Asia/Tokyo' },
  },
});
