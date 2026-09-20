/// 画面ごとのデスクトップ幅のレイアウト。幅の出し分けは CSS なので、jsdom からは
/// 見えない（PORTING.md「デスクトップ幅の作り分け」）。寸法そのものを実測する。

import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';
import { goToResult } from './flows';

const desktop = { width: 1280, height: 900 };
const mobile = { width: 375, height: 812 };

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (value === null) throw new Error('要素が描かれていない');
  return value;
}

test('デスクトップ幅の home は設定ボタンを出さない', async ({ page }) => {
  // シェルのタブが同じ導線を持つ。ハンドオフのルート計画にも歯車は無い。
  await page.setViewportSize(desktop);
  await page.goto('/');

  await expect(page.getByRole('button', { name: '設定を開く' })).toBeHidden();
});

test('モバイル幅の home は設定ボタンを出す', async ({ page }) => {
  await page.setViewportSize(mobile);
  await page.goto('/');

  await expect(page.getByRole('button', { name: '設定を開く' })).toBeVisible();
});

test('デスクトップ幅の設定は本文を 760px で中央へ寄せる', async ({ page }) => {
  await page.setViewportSize(desktop);
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('設定');

  const main = await box(page.getByRole('main'));

  expect(main.width).toBeLessThanOrEqual(760);
  // 中央寄せ: 左右の余白が等しい。
  expect(Math.round(main.x)).toBe(Math.round(desktop.width - main.x - main.width));
});

test('デスクトップ幅の設定はセクションのラベルをカードの左列へ出す', async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();

  const label = await box(page.getByRole('heading', { name: '法的情報' }));
  const card = await box(page.getByRole('link', { name: '利用規約' }));

  // 同じ行に並ぶ（ラベルが上に積まれていない）。
  expect(label.x + label.width).toBeLessThanOrEqual(card.x);
  expect(label.y).toBeLessThan(card.y + card.height);
});

test('モバイル幅の設定はラベルをカードの上へ積む', async ({ page }) => {
  await page.setViewportSize(mobile);
  await page.goto('/home/settings');

  const label = await box(page.getByRole('heading', { name: '法的情報' }));
  const card = await box(page.getByRole('link', { name: '利用規約' }));

  expect(label.y + label.height).toBeLessThanOrEqual(card.y);
});

test('デスクトップ幅の結果は左パネルと全面地図の2カラムになる', async ({
  page,
  upstream,
}) => {
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(desktop);
  await goToResult(page);

  const panel = await box(page.getByTestId('result-panel'));
  const map = await box(page.getByTestId('result-map'));

  // 移植元の splitPanelWidth は 380、ハンドオフは minmax(340px, 400px)。
  expect(panel.width).toBeGreaterThanOrEqual(340);
  expect(panel.width).toBeLessThanOrEqual(400);

  // 地図は右の残り全部で、ビューポートの高さいっぱい。
  expect(map.x).toBeGreaterThanOrEqual(panel.x + panel.width);
  expect(Math.round(map.x + map.width)).toBe(desktop.width);
  expect(map.height).toBeGreaterThan(desktop.height * 0.8);
});

test('デスクトップ幅の結果はページごとではなく左パネルだけがスクロールする', async ({
  page,
  upstream,
}) => {
  // 移植元が #262 で踏んだ形。一括スクロールにすると、ビューポート固定の分割
  // ビューから下部の導線が押し出される。
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 420 });
  await goToResult(page);

  const scrolled = await page
    .getByTestId('result-panel')
    .evaluate((el) => {
      el.scrollTop = 120;
      return el.scrollTop;
    });
  const pageScrolls = await page.evaluate(() => {
    const root = document.scrollingElement;
    if (root === null) throw new Error('scrollingElement が無い');
    return root.scrollHeight > root.clientHeight;
  });

  expect(scrolled).toBeGreaterThan(0);
  expect(pageScrolls).toBe(false);
});

test('モバイル幅の結果は地図を挟んだ縦積みのまま', async ({ page, upstream }) => {
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(mobile);
  await goToResult(page, 'screen');

  const map = await box(page.getByTestId('result-map'));
  const panel = await box(page.getByTestId('result-panel'));

  // 移植元 _RouteMapPreview の固定高 180px。
  expect(Math.round(map.height)).toBe(180);
  expect(panel.y).toBeGreaterThanOrEqual(map.y + map.height);
  expect(Math.round(map.width)).toBe(mobile.width - 36);
});
