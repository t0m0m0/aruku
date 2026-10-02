/// 幅による出し分け。jsdom は CSS を読まないので、**単体テストからは原理的に
/// 見えない**——`useIsDesktop` の両側は test/layout/ で押さえてあるが、それが
/// 実際の 820px で切り替わることと、切り替えた先が縦にはみ出さないことは
/// 実ブラウザでしか確かめられない。

import { expect, test } from './fixtures';
import { goToResult } from './flows';

const desktop = { width: 1280, height: 900 };

/// 移植元（#372）が「既存のモバイル UI をそのまま使う」と決めた側。
const mobile = { width: 375, height: 812 };

async function verticalOverflow(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement;
    if (root === null) throw new Error('scrollingElement が無い');
    return root.scrollHeight - root.clientHeight;
  });
}

test('デスクトップ幅では上部バーが出る', async ({ page }) => {
  await page.setViewportSize(desktop);
  await page.goto('/');

  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ルートを計画' })).toBeVisible();
});

test('モバイル幅では上部バーが出ない', async ({ page }) => {
  await page.setViewportSize(mobile);
  await page.goto('/');

  await expect(page.getByRole('banner')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('今日も、歩こう。');
});

test('上部バーのぶん縦にはみ出さない', async ({ page }) => {
  // 各画面は「1画面ぶん」の高さを取る。バーが 64px を持っていくので、基準を
  // 100dvh のままにすると全画面が必ずバーの高さだけスクロールする。
  await page.setViewportSize(desktop);
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();

  expect(await verticalOverflow(page)).toBe(0);
});

test('幅を狭めるとモバイル UI へ戻る', async ({ page }) => {
  await page.setViewportSize(desktop);
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();

  await page.setViewportSize(mobile);

  await expect(page.getByRole('banner')).toHaveCount(0);
});

test('結果画面から「ルートを計画」で戻っても履歴は [home, 子] のまま', async ({
  page,
  upstream,
}) => {
  // タブは go() を通る。通さずに router.navigate を直に呼ぶと、子から home への
  // pop が失われ、履歴が伸びる（navigator.ts）。
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(desktop);
  await goToResult(page);
  const before = await page.evaluate(() => window.history.length);

  await page.getByRole('button', { name: 'ルートを計画' }).click();
  await expect(page).toHaveURL(/\/home$/);

  expect(await page.evaluate(() => window.history.length)).toBe(before);
});

test('待ち画面から「ルートを計画」で離れると、home に留まる', async ({
  page,
  upstream,
}) => {
  // 実ブラウザの `history.back()` は非同期。打ち切りの戻りと、タブが要求した遷移が
  // 二重に走ると履歴が狂う。MemoryRouter は同期に更新するのでこの競合を再現しない
  // （PR #407 の Codex レビュー）。上流の応答より長く見て、検索の完了が結果画面へ
  // 引き戻さないことも確かめる。
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(desktop);
  await page.route(
    (url) => url.pathname.includes('/guidance/plan'),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.fallback();
    },
  );

  await page.goto('/');
  const before = await page.evaluate(() => window.history.length);
  await page.getByRole('combobox', { name: '目的地を検索' }).fill('テスト');
  await page.getByRole('option', { name: /テスト公園/ }).click();
  await page.getByRole('button', { name: 'ルートを検索' }).click();
  await expect(page).toHaveURL('/home/loading');

  await page.getByRole('button', { name: 'ルートを計画' }).click();

  await expect(page).toHaveURL('/home');
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL('/home');
  expect(await page.evaluate(() => window.history.length)).toBe(before + 1);
});
