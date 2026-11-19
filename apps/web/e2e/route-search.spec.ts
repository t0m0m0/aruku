import type { Page } from '@playwright/test';

import { destinationPlace, currentPosition } from './world';
import { expect, test } from './fixtures';
import { fakeRailLine } from './upstream/fake-upstream';

test.use({ viewport: { width: 375, height: 812 } });

function todayInTokyo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replaceAll('-', '');
}

const clocks = [
  { label: '昼', now: '2026-09-11T12:00:00+09:00' },
  { label: '締切が日をまたぐ深夜', now: '2026-09-11T23:30:00+09:00' },
];

for (const { label, now } of clocks) {
  test(`現在地から目的地を選んで経路を出す（${label}）`, async ({ page, upstream: _upstream }) => {
    await page.clock.setFixedTime(new Date(now));
    await mainFlow(page);
  });
}

async function mainFlow(page: Page) {
  await page.goto('/');

  await expect(page.getByRole('button', { name: '出発 現在地' })).toBeVisible();

  await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
  await expect(page).toHaveURL('/home/search');

  await page.getByRole('searchbox', { name: '目的地を検索' }).fill('テスト');

  await expect(page.getByRole('button', { name: /^テスト公園 / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^テスト会館 / })).toBeVisible();

  await page.getByRole('button', { name: /^テスト公園 / }).click();

  await expect(page).toHaveURL('/home');
  await expect(page.getByRole('button', { name: '目的地 テスト公園' })).toBeVisible();

  await page.getByRole('button', { name: '歩けるルートを探す' }).click();

  await expect(page).toHaveURL('/home/result');

  const auxiliary = page.getByRole('region', { name: 'このルートについて' });
  await expect(auxiliary.getByText(/^\d{1,2}:\d{2} まで .+ 余裕$/)).toBeVisible();
  await expect(auxiliary.getByText(/^消費カロリー \d+ kcal$/)).toBeVisible();

  await expect(page.getByText(fakeRailLine).first()).toBeVisible();
  await expect(page.getByText('徒歩').first()).toBeVisible();

  const mapsLinks = page.getByRole('link', { name: /をGoogleマップで開く$/ });
  await expect(mapsLinks.first()).toBeVisible();
  const modes = new Set<string | null>();
  for (const href of await mapsLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')),
  )) {
    const query = new URL(href!).searchParams;
    expect(query.get('destination')).toMatch(/^-?[\d.]+,-?[\d.]+$/);
    modes.add(query.get('travelmode'));
  }
  expect(modes).toEqual(new Set(['walking', 'transit']));
}

test('上流へ渡す照会の中身が、画面で選んだ地点と一致する', async ({ page, upstream }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '出発 現在地' })).toBeVisible();

  await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
  await page.getByRole('searchbox', { name: '目的地を検索' }).fill('テスト公園');
  await page.getByRole('button', { name: /^テスト公園 / }).click();
  await page.getByRole('button', { name: '歩けるルートを探す' }).click();
  await expect(page).toHaveURL('/home/result');

  expect(upstream.places.map((u) => u.searchParams.get('action'))).toContain('details');

  const departure = upstream.guidance.filter((u) => u.searchParams.get('type') === 'departure')[0];

  expect(departure.searchParams.get('from')).toBe(
    `geo:${currentPosition.latitude},${currentPosition.longitude}`,
  );
  expect(departure.searchParams.get('to')).toBe(
    `geo:${destinationPlace.lat},${destinationPlace.lng}`,
  );
  expect(departure.searchParams.get('date')).toBe(todayInTokyo());
  expect(departure.searchParams.get('numItineraries')).toBe('5');

  expect(departure.searchParams.get('avoidModes')).toBe('bus,ferry,air');

  expect(upstream.guidance.some((u) => u.searchParams.get('type') === 'arrival')).toBe(true);

  expect(upstream.matrix.length).toBeGreaterThan(0);
  expect(upstream.walk.length).toBeGreaterThan(0);
});
