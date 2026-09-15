/// spec が共有する治具。偽の上流の設置と、**見えない失敗**の番人を1箇所に置く。

import { expect, test as base } from '@playwright/test';

import { previewOrigin } from './upstream/endpoints';
import { installFakeUpstream, type UpstreamLog } from './upstream/fake-upstream';
import { places } from './world';

interface Fixtures {
  /// 偽の上流が受け取った要求の記録。使う spec だけが受け取る。
  upstream: UpstreamLog;

  /// 画面に出ない失敗を落とす番人。全 spec に自動で付く。
  guards: void;
}

export const test = base.extend<Fixtures>({
  upstream: async ({ page }, use) => {
    const log = await installFakeUpstream(page, { places });

    await use(log);

    // どのハンドラにも当たらなかった上流要求は、配線か偽の上流の取りこぼし。
    // 画面は縮退（候補ドロップ・直線推定）で吸収してしまうので、ここで落とす。
    expect(log.unmatched.map((u) => `${u.pathname}${u.search}`)).toEqual([]);
  },

  guards: [
    async ({ page }, use) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const external: string[] = [];

      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
      });
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (!url.protocol.startsWith('http')) return;
        if (url.origin === previewOrigin) return;
        external.push(request.url());
      });

      await use();

      // 握り潰された例外は画面に出ないことがある（縮退の catch）。テストが緑のまま
      // 壊れているのを避けるため、コンソールの error は失敗として扱う。
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);

      // 外部オリジンへ1本も出ないこと。
      //
      // 2つを同時に見張っている:
      // - 上流（Transit API・プロキシ・Firebase）が偽物ではなく本物へ漏れていないか。
      //   漏れた要求は App Check 無しで 401 になり、画面には「通信に失敗」としか出ない
      // - フォントが**同梱**されているか（スライス9）。ランタイム取得へ戻ると、
      //   ここに fonts.gstatic.com が並ぶ。画面を見ても分からない種類の退行
      expect(external).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
