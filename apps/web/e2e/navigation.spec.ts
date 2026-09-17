/// 履歴の積み方。PORTING.md の「戻り挙動」が **実ブラウザで確認** としか書けなかった
/// 不変条件を、ここで反証可能にする。
///
/// 単体テストでは押さえられない。jsdom の履歴はスタブで、React Router がマウント前に
/// 積んだ生の History API のエントリも、リロードで状態が消えることも再現しない
/// ——移植中に見つかった穴（敷いた home が1つ余る・リロードのたびに増える）は、
/// どれも実ブラウザでしか出ていない。

import { expect, test } from './fixtures';

/// Playwright の新しいページが最初から居る about:blank の1エントリ。goto はこれを
/// 置き換えず**積む**ので、素の `history.length` はアプリのぶんより常に1多い。
/// 前提が変わったら beforeEach が落ちる。
const blankEntry = 1;

test.beforeEach(async ({ page }) => {
  expect(await page.evaluate(() => window.history.length)).toBe(blankEntry);
});

/// このタブが持つ**アプリの**履歴エントリ数。不変条件は「常に高々 [home, 子] の2つ」。
async function appHistoryDepth(
  page: import('@playwright/test').Page,
): Promise<number> {
  return (await page.evaluate(() => window.history.length)) - blankEntry;
}

test('アプリ内で開いた子から戻ると home へ降り、履歴は [home, 子] のまま', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(1);

  await page.getByRole('button', { name: '設定を開く' }).click();
  await expect(page).toHaveURL('/home/settings');
  expect(await appHistoryDepth(page)).toBe(2);

  await page.goBack();
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(2);
});

test('直接開いた子からも戻ると home へ降りる', async ({ page }) => {
  // ルーターがマウントする前に生の History API で home を敷いている。敷かないと、
  // deep link で入った利用者の「戻る」が即サイト離脱になる。
  await page.goto('/home/settings');
  await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();
  expect(await appHistoryDepth(page)).toBe(2);

  await page.goBack();
  await expect(page).toHaveURL('/home');
});

test('表示前提を欠く子を直接開くと home へ寄せ、拒んだ location を履歴に残さない', async ({
  page,
}) => {
  // 経路を持たないストアでは result のガードが通らない。跳ね返しは replace なので
  // /home/result は履歴に残らず、home も敷かれない（敷くと余分な home が下に残る）。
  await page.goto('/home/result');
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(1);
});

test('アプリ内で開いた子をリロードしても home が増えない', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '設定を開く' }).click();
  await expect(page).toHaveURL('/home/settings');

  // 履歴は既に [home, settings]。ルーター由来のエントリだと分かる印
  // （history.state の {idx, key, usr}）を見て敷き直さない。見ないとリロードの
  // たびに home が1つ増える。
  await page.reload();
  await expect(page).toHaveURL('/home/settings');
  expect(await appHistoryDepth(page)).toBe(2);

  await page.reload();
  expect(await appHistoryDepth(page)).toBe(2);
});

test('リロードで前提を失った結果画面からは、真下の home へ降りる', async ({
  page,
  upstream,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '出発 現在地' })).toBeVisible();
  await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
  await page.getByRole('searchbox', { name: '目的地を検索' }).fill('テスト公園');
  await page.getByRole('button', { name: /^テスト公園 / }).click();
  await page.getByRole('button', { name: 'ルートを検索' }).click();
  await expect(page).toHaveURL('/home/result');
  expect(await appHistoryDepth(page)).toBe(2);

  // 経路はメモリ上のストアにしか無いので、リロードでガードを通らなくなる。
  // ガードに跳ね返させると真下の home と重なるため、`history.back()` で降りる
  // ——降りるだけならエントリは増えない。
  await page.reload();
  await expect(page).toHaveURL('/home');
  expect(await appHistoryDepth(page)).toBe(2);
});
