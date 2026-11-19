import type { Page, Request } from '@playwright/test';

import { expect, test } from './fixtures';

function isAutocomplete(url: URL): boolean {
  return url.pathname.endsWith('/placesProxy') && url.searchParams.get('action') === 'autocomplete';
}

async function delayAutocomplete(
  page: Page,
  delayFor: (input: string) => number,
): Promise<{ aborted: string[] }> {
  const aborted: string[] = [];
  page.on('requestfailed', (request: Request) => {
    const url = new URL(request.url());
    if (isAutocomplete(url) && request.failure()?.errorText.includes('ABORTED') === true) {
      aborted.push(url.searchParams.get('input') ?? '');
    }
  });
  await page.route(isAutocomplete, async (route) => {
    const input = new URL(route.request().url()).searchParams.get('input') ?? '';
    await new Promise((resolve) => setTimeout(resolve, delayFor(input)));
    await route.fallback().catch(() => {});
  });
  return { aborted };
}

test.describe('デスクトップ幅の欄', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('打ち替えると前の要求を中止し、最新の候補だけが出る', async ({ page, upstream }) => {
    const { aborted } = await delayAutocomplete(page, (input) => (input === 'テスト公' ? 3000 : 0));
    await page.goto('/');
    const field = page.getByRole('combobox', { name: '目的地を検索' });

    const first = page.waitForRequest((r) => isAutocomplete(new URL(r.url())));
    await field.fill('テスト公');
    await first;
    await field.fill('テスト会');

    await expect(page.getByRole('option', { name: /テスト会館/ })).toBeVisible();
    await expect.poll(() => aborted).toEqual(['テスト公']);

    await page.waitForTimeout(3000);
    await expect(page.getByRole('option', { name: /テスト会館/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /テスト公園/ })).toHaveCount(0);
    await expect(page.getByText('検索できませんでした')).toHaveCount(0);
    expect(upstream.places.length).toBeGreaterThan(0);
  });

  test('入力を消すと走っている要求を中止し、エラーを出さない', async ({ page, upstream }) => {
    expect(upstream.unmatched).toEqual([]);
    const { aborted } = await delayAutocomplete(page, () => 3000);
    await page.goto('/');
    const field = page.getByRole('combobox', { name: '目的地を検索' });

    const first = page.waitForRequest((r) => isAutocomplete(new URL(r.url())));
    await field.fill('テスト');
    await first;
    await field.fill('');

    await expect.poll(() => aborted).toEqual(['テスト']);
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(page.getByText('検索できませんでした')).toHaveCount(0);
  });
});

test.describe('モバイル幅の全画面検索', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('検索の途中で画面を離れると要求を中止し、エラーを出さない', async ({ page, upstream }) => {
    expect(upstream.unmatched).toEqual([]);
    const { aborted } = await delayAutocomplete(page, () => 3000);
    await page.goto('/');
    await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
    await expect(page).toHaveURL('/home/search');

    const first = page.waitForRequest((r) => isAutocomplete(new URL(r.url())));
    await page.getByRole('searchbox', { name: '目的地を検索' }).fill('テスト');
    await first;
    await page.goBack();

    await expect(page).toHaveURL('/home');
    await expect.poll(() => aborted).toEqual(['テスト']);
    await page.waitForTimeout(3000);
    await expect(page.getByRole('button', { name: '目的地 どこへ歩く?' })).toBeVisible();
  });
});
