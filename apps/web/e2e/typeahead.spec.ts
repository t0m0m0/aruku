/// デスクトップ幅の目的地欄。単体テスト（test/features/search/typeahead-field.test.tsx）
/// が押さえられないのは、実物の焦点とキー入力——jsdom の fireEvent は焦点の移動も
/// IME も再現しない。ここで見るのは「キーボードだけで、遷移せずに決まる」こと。

import { expect, test } from './fixtures';

test.use({ viewport: { width: 1280, height: 900 } });

test('打って ↓ と Enter だけで目的地が決まり、画面は動かない', async ({
  page,
  upstream,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '出発 現在地' })).toBeVisible();

  const field = page.getByRole('combobox', { name: '目的地を検索' });
  await field.fill('テスト');
  await expect(page.getByRole('option', { name: /テスト公園/ })).toBeVisible();

  await field.press('ArrowDown');
  await field.press('Enter');

  // 欄が確定した地点を映し、一覧は閉じ、URL は home のまま。
  await expect(field).toHaveValue('テスト会館');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page).toHaveURL('/home');

  // 条件が揃ったので CTA が検索になる。
  await expect(page.getByRole('button', { name: 'ルートを検索' })).toBeVisible();
  expect(upstream.places.length).toBeGreaterThan(0);
});

test('Escape で一覧だけ閉じる', async ({ page, upstream }) => {
  expect(upstream.unmatched).toEqual([]);
  await page.goto('/');
  const field = page.getByRole('combobox', { name: '目的地を検索' });

  await field.fill('テスト');
  await expect(page.getByRole('option', { name: /テスト公園/ })).toBeVisible();
  await field.press('Escape');

  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(field).toHaveValue('テスト');
});
