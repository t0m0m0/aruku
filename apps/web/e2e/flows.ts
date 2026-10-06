/// 画面をまたぐ導線のうち、複数の spec が前提として通るもの。

import type { Page } from '@playwright/test';

import { expect } from './fixtures';

/// 目的地の決め方は幅で変わる。モバイル幅は全画面の検索へ遷移し、デスクトップ幅は
/// 条件カードの中のインライン欄で完結する（#406）。
export type DestinationRoute = 'screen' | 'inline';

/// home から目的地を選び、経路の結果画面まで進む。
///
/// 偽の上流（fixtures の `upstream`）が要る。呼ぶ側がその治具を受け取っていないと、
/// 本物へ出て「通信に失敗」の画面で止まる。
export async function goToResult(
  page: Page,
  how: DestinationRoute = 'inline',
): Promise<void> {
  await page.goto('/');
  await waitForCurrentLocation(page, how);

  if (how === 'screen') {
    await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
    await page.getByRole('searchbox', { name: '目的地を検索' }).fill('テスト');
    await page.getByRole('button', { name: /^テスト公園 / }).click();
  } else {
    await page.getByRole('combobox', { name: '目的地を検索' }).fill('テスト');
    await page.getByRole('option', { name: /テスト公園/ }).click();
  }

  await page.getByRole('button', { name: '歩けるルートを探す' }).click();
  await expect(page).toHaveURL('/home/result');
}

/// 現在地が確定し、出発が「現在地」で出るまで待つ。
///
/// 出発の出方も幅で変わる。モバイル幅はボタンの読み上げ名に、デスクトップ幅は
/// 打てる欄の placeholder に出る（#430）。
export async function waitForCurrentLocation(
  page: Page,
  how: DestinationRoute,
): Promise<void> {
  if (how === 'screen') {
    await expect(page.getByRole('button', { name: '出発 現在地' })).toBeVisible();
  } else {
    await expect(page.getByRole('combobox', { name: '出発地を検索' })).toHaveAttribute(
      'placeholder',
      '現在地',
    );
  }
}
