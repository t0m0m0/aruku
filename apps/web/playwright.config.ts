import { defineConfig, devices } from '@playwright/test';

import {
  previewOrigin,
  previewOutDir,
  previewPort,
  proxyBaseUrl,
  transitBaseUrl,
} from './e2e/upstream/endpoints';
import { currentPosition } from './e2e/world';

/// E2E は**本番ビルドの成果物**に対して走らせる。
///
/// 開発サーバにしない理由が2つある。`import.meta.env.DEV` が真だと App Check が
/// デバッグプロバイダで有効化され、起動のたびに Firebase へトークン交換に出る
/// （firebase/app-check.ts）——E2E が実ネットワークと外部の状態に依存する。もう1つは、
/// 定数畳み込みで消えるはずのコードが残っていないかを見られるのが本番ビルドだけで、
/// そこは配信する当のものだから。ビルドは実測 1.2 秒で、毎回作り直しても足を引かない。
const build = [
  'npx vite build',
  '--mode production',
  `--outDir ${previewOutDir}`,
  '--emptyOutDir',
  '--logLevel warn',
].join(' ');

const serve = [
  'npx vite preview',
  `--outDir ${previewOutDir}`,
  `--port ${previewPort}`,
  // 空きを探させない。別の番号で上がると、バンドルへ焼いたベース URL と食い違う。
  '--strictPort',
].join(' ');

export default defineConfig({
  testDir: './e2e',

  // vitest（test/）と混ざらないよう拡張子で分ける。
  testMatch: '**/*.spec.ts',

  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,

  // 再試行しない。落ちたら落ちたままにする——E2E の再試行は、実際に壊れている
  // 競合を「たまに赤い」だけの見た目へ薄める。
  retries: 0,

  reporter: process.env.CI !== undefined ? 'github' : 'list',

  use: {
    baseURL: previewOrigin,
    locale: 'ja-JP',

    // vitest 側（vite.config.ts の `env.TZ`）と同じ理由で固定する。エンジンの時刻
    // ロジックは naive JST 前提で、実行環境の TZ が違うと境界の期待値がずれる。
    timezoneId: 'Asia/Tokyo',

    // 現在地は主導線の前提（出発地が無いと検索は NO_ORIGIN で落ちる）。ダイアログを
    // 出さずに確定させる。
    permissions: ['geolocation'],
    geolocation: currentPosition,

    trace: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `${build} && ${serve}`,
    url: previewOrigin,

    // 既に上がっているプレビューを使い回さない。使い回すと、直前の編集を含まない
    // 古い成果物に対して緑になる。作り直しが安いので、常に作る。
    reuseExistingServer: false,

    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 120_000,

    env: {
      // 上流はすべて偽物（同一オリジン）へ向ける。
      VITE_PROXY_BASE_URL: proxyBaseUrl,
      VITE_TRANSIT_API_BASE_URL: transitBaseUrl,

      // 開発者の .env から実値が**焼き込まれない**よう、空で上書きする
      // （process.env は .env より優先される）。サイトキーが入ると App Check が
      // reCAPTCHA を読みに行き、Maps のキーが入ると実地図が Google を叩く
      // ——どちらも `guards` の「外部オリジンへ出ない」で赤くなるが、原因が遠い。
      VITE_RECAPTCHA_SITE_KEY: '',
      VITE_MAPS_WEB_API_KEY: '',
      VITE_FIREBASE_WEB_API_KEY: '',
      VITE_FIREBASE_WEB_APP_ID: '',
      VITE_APP_CHECK_DEBUG_TOKEN: '',

      // vitest の NODE_ENV=test が漏れて開発バンドルを検査した事故
      // （test/build/production-bundle.test.ts）と同じ穴を塞ぐ。
      NODE_ENV: 'production',
    },
  },
});
