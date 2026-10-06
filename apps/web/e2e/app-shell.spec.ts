/// 上部バーは #439 から幅に関係なく出る。バーが高さを持っていった残りに各画面が
/// 収まり、縦にはみ出さないことは jsdom（CSS を読まない）からは原理的に見えず、
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
    // 各画面は「1画面ぶん」の高さを取る。バーが高さを持っていくので、基準を
    // 100dvh のままにすると全画面が必ずバーの高さだけスクロールする。
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();

    expect(await verticalOverflow(page)).toBe(0);
  });
}

test('幅を狭めても上部バーは残る', async ({ page }) => {
  await page.setViewportSize(desktop);
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();

  await page.setViewportSize(mobile);

  await expect(page.getByRole('banner')).toBeVisible();
});

test('結果画面からロゴで home へ戻っても履歴は [home, 子] のまま', async ({
  page,
  upstream,
}) => {
  // ロゴは go() を通る。通さずに router.navigate を直に呼ぶと、子から home への
  // pop が push になり、履歴が伸びる（navigator.ts）。
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
  // 画面を移しても探索は走り続け、打ち切らなければ完了時に result へ引き戻す。
  // 実ブラウザの `history.back()` は非同期で、MemoryRouter の単体テストでは
  // 遷移と完了の前後を再現できない（PR #407 の Codex レビュー）。
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
  // 上流の遅延より長く見る。
  await page.waitForTimeout(2500);
  await expect(page).toHaveURL('/home');
});
