import { expect, test } from './fixtures';
import { previewOrigin } from './upstream/endpoints';

// 法的文書は SPA ではなく public/ の静的ページとして配信する。ここで見るのは、
// home の下端のリンクが SPA のフォールバック（index.html）ではなくその文書に届くこと。
test.describe('home の法的情報', () => {
  for (const { link, path } of [
    { link: '利用規約', path: '/terms' },
    { link: 'プライバシーポリシー', path: '/privacy' },
  ]) {
    test(`「${link}」から本文が開く`, async ({ page, context }) => {
      await page.goto('/');

      const [opened] = await Promise.all([
        context.waitForEvent('page'),
        page.getByRole('navigation', { name: '法的情報' }).getByRole('link', { name: link }).click(),
      ]);
      await opened.waitForLoadState();

      // オリジンまで見る。パスだけだと外部サイトの同名パスでも緑になる。
      expect(opened.url()).toBe(`${previewOrigin}${path}`);
      await expect(opened.getByRole('heading', { level: 1 })).toHaveText(link);
    });
  }
});
