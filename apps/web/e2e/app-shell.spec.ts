import { expect, test } from './fixtures';
import { goToResult } from './flows';

const desktop = { width: 1280, height: 900 };

const mobile = { width: 375, height: 812 };

async function verticalOverflow(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement;
    if (root === null) throw new Error('scrollingElement が無い');
    return root.scrollHeight - root.clientHeight;
  });
}

for (const [name, viewport] of [
  ['デスクトップ幅', desktop],
  ['モバイル幅', mobile],
] as const) {
  test(`${name}でも上部バーが出る`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('banner').getByRole('button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'あるく ホームへ戻る' })).toBeVisible();
  });

  test(`${name}で上部バーのぶん縦にはみ出さない`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();

    expect(await verticalOverflow(page)).toBe(0);
  });
}

test('広い画面でもロゴは中央へ寄らず左端に付く', async ({ page }) => {
  await page.setViewportSize({ width: 1960, height: 900 });
  await page.goto('/');

  const logo = await page.getByRole('button', { name: 'あるく ホームへ戻る' }).boundingBox();
  expect(logo?.x).toBeLessThanOrEqual(24);
});

test('幅を狭めても上部バーは残る', async ({ page }) => {
  await page.setViewportSize(desktop);
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();

  await page.setViewportSize(mobile);

  await expect(page.getByRole('banner')).toBeVisible();
});

test('結果画面からロゴで home へ戻っても履歴は [home, 子] のまま', async ({ page, upstream }) => {
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(desktop);
  await goToResult(page);
  const atResult = await page.evaluate(() => window.history.length);

  await page.getByRole('button', { name: 'あるく ホームへ戻る' }).click();
  await expect(page).toHaveURL(/\/home$/);

  expect(await page.evaluate(() => window.history.length)).toBe(atResult);
});

test('待ち画面からロゴで home へ降りると、探索の完了で引き戻されない', async ({
  page,
  upstream,
}) => {
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(desktop);
  await page.route(
    (url) => url.pathname.includes('/guidance/plan'),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fallback();
    },
  );

  await page.goto('/');
  await page.getByRole('combobox', { name: '目的地を検索' }).fill('テスト');
  await page.getByRole('option', { name: /テスト公園/ }).click();
  await page.getByRole('button', { name: '歩けるルートを探す' }).click();
  await expect(page).toHaveURL('/home/loading');

  await page.getByRole('button', { name: 'あるく ホームへ戻る' }).click();

  await expect(page).toHaveURL('/home');
  await page.waitForTimeout(2500);
  await expect(page).toHaveURL('/home');
});
