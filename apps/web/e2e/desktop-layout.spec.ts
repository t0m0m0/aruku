/// 画面ごとのデスクトップ幅のレイアウト。幅の出し分けは CSS なので、jsdom からは
/// 見えない（PORTING.md「デスクトップ幅の作り分け」）。寸法そのものを実測する。

import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures';

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
