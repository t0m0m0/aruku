import { expect, test } from './fixtures';

test.use({ viewport: { width: 375, height: 812 } });

const blankEntry = 1;

test.beforeEach(async ({ page }) => {
  expect(await page.evaluate(() => window.history.length)).toBe(blankEntry);
});

async function appHistoryDepth(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(() => window.history.length)) - blankEntry;
}

test('アプリ内で開いた子から戻ると home へ降り、履歴は [home, 子] のまま', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(1);

  await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
  await expect(page).toHaveURL('/home/search');
  expect(await appHistoryDepth(page)).toBe(2);

  await page.goBack();
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(2);
});

test('直接開いた子からも戻ると home へ降りる', async ({ page }) => {
  await page.goto('/home/search');
  await expect(page.getByRole('searchbox', { name: '目的地を検索' })).toBeVisible();
  expect(await appHistoryDepth(page)).toBe(2);

  await page.goBack();
  await expect(page).toHaveURL('/home');
});

test('表示前提を欠く子を直接開くと home へ寄せ、拒んだ location を履歴に残さない', async ({
  page,
}) => {
  await page.goto('/home/result');
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(1);
});

test('撤去した設定画面の URL は home へ寄せ、履歴に残さない', async ({ page }) => {
  await page.goto('/home/settings');
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(1);
});

test('アプリ内で開いた子をリロードしても home が増えない', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
  await expect(page).toHaveURL('/home/search');

  await page.reload();
  await expect(page).toHaveURL('/home/search');
  expect(await appHistoryDepth(page)).toBe(2);

  await page.reload();
  expect(await appHistoryDepth(page)).toBe(2);
});

test('リロードで前提を失った結果画面からは、真下の home へ降りる', async ({
  page,
  upstream: _upstream,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '出発 現在地' })).toBeVisible();
  await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
  await page.getByRole('searchbox', { name: '目的地を検索' }).fill('テスト公園');
  await page.getByRole('button', { name: /^テスト公園 / }).click();
  await page.getByRole('button', { name: '歩けるルートを探す' }).click();
  await expect(page).toHaveURL('/home/result');
  expect(await appHistoryDepth(page)).toBe(2);

  await page.reload();
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(2);
});
