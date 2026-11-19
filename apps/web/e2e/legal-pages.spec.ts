import { expect, test } from './fixtures';
import { previewOrigin } from './upstream/endpoints';

test.describe('home の法的情報', () => {
  for (const { link, path } of [
    { link: '利用規約', path: '/terms' },
    { link: 'プライバシーポリシー', path: '/privacy' },
  ]) {
    test(`「${link}」から本文が開く`, async ({ page, context }) => {
      await page.goto('/');

      const [opened] = await Promise.all([
        context.waitForEvent('page'),
        page
          .getByRole('navigation', { name: '法的情報' })
          .getByRole('link', { name: link })
          .click(),
      ]);
      await opened.waitForLoadState();

      expect(opened.url()).toBe(`${previewOrigin}${path}`);
      await expect(opened.getByRole('heading', { level: 1 })).toHaveText(link);
    });
  }
});
