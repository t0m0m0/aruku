import type { Page } from '@playwright/test';

import { expect } from './fixtures';

export type DestinationRoute = 'screen' | 'inline';

export async function goToResult(page: Page, how: DestinationRoute = 'inline'): Promise<void> {
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

export async function waitForCurrentLocation(page: Page, how: DestinationRoute): Promise<void> {
  if (how === 'screen') {
    await expect(page.getByRole('button', { name: '出発 現在地' })).toBeVisible();
  } else {
    await expect(page.getByRole('combobox', { name: '出発地を検索' })).toHaveAttribute(
      'placeholder',
      '現在地',
    );
  }
}
