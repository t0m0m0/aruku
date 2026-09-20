/// 幅による出し分け。jsdom は CSS を読まないので、**単体テストからは原理的に
/// 見えない**——`useIsDesktop` の両側は test/layout/ で押さえてあるが、それが
/// 実際の 820px で切り替わることと、切り替えた先が縦にはみ出さないことは
/// 実ブラウザでしか確かめられない。

import { expect, test } from './fixtures';

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

test('タブで設定と行き来しても履歴は [home, 子] のまま', async ({ page }) => {
  // タブは go() を通る。通さずに router.navigate を直に呼ぶと、子から子への
  // replace も子から home への pop も失われ、履歴が伸びる（navigator.ts）。
  await page.setViewportSize(desktop);
  await page.goto('/');
  const before = await page.evaluate(() => window.history.length);

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page).toHaveURL(/\/home\/settings$/);
  await page.getByRole('button', { name: 'ルートを計画' }).click();
  await expect(page).toHaveURL(/\/home$/);

  expect(await page.evaluate(() => window.history.length)).toBe(before + 1);
});
