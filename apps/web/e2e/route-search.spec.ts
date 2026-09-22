/// 主導線——現在地を取り、目的地を選び、経路を出すまで。
///
/// 単体テスト（test/）が押さえていないのは、7 画面と偽物でない**実物の**ルーター・
/// 履歴・fetch・本番ビルドの成果物が一続きに繋がっているか。移植の間ずっと
/// 「実ブラウザで確認」と書き残してきた種類の確認が、ここから自動になる。

import { destinationPlace, currentPosition } from './world';
import { expect, test } from './fixtures';
import { fakeRailLine } from './upstream/fake-upstream';

/// このファイルは**モバイル幅**で走らせる。主題は主導線で、目的地は全画面の検索
/// 画面で選んでいる——デスクトップ幅ではその画面を経由せず、条件カードの中の
/// インライン欄で決める（#406）。デスクトップ側の主導線は desktop-layout.spec.ts と
/// typeahead.spec.ts が通る。
test.use({ viewport: { width: 375, height: 812 } });

/// ブラウザの時計（Asia/Tokyo 固定）で今日。UTC の CI で走らせても、深夜に
/// 日付が1日ずれた期待値にならないようにする。
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

test('現在地から目的地を選んで経路を出す', async ({ page, upstream }) => {
  await page.goto('/');

  // 現在地が確定するまで出発は「取得中...」。確定した名前で出ることを待つ。
  await expect(page.getByRole('button', { name: '出発 現在地' })).toBeVisible();

  await page.getByRole('button', { name: '目的地 どこへ歩く?' }).click();
  await expect(page).toHaveURL('/home/search');

  // 役割まで指定する。読み上げ名「目的地を検索」は home の検索アイコンとも重なって
  // いて、遷移が終わる前に引くと home のボタンへ当たる（実際に当たった）。
  await page.getByRole('searchbox', { name: '目的地を検索' }).fill('テスト');

  // 打った語に当たる候補だけが出る（placesProxy の input がそのまま届いている証拠）。
  await expect(page.getByRole('button', { name: /^テスト公園 / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^テスト会館 / })).toBeVisible();

  await page.getByRole('button', { name: /^テスト公園 / }).click();

  // 選んだ側だけが home へ入る。
  await expect(page).toHaveURL('/home');
  await expect(page.getByRole('button', { name: '目的地 テスト公園' })).toBeVisible();

  await page.getByRole('button', { name: 'ルートを検索' }).click();

  await expect(page).toHaveURL('/home/result');

  // 合計。3 つとも出ていることと、時間が予算に収まっていること。
  await expect(page.getByText('所要時間')).toBeVisible();
  await expect(page.getByText('徒歩距離')).toBeVisible();
  await expect(page.getByText('消費カロリー')).toBeVisible();
  await expect(page.getByText(/制限 .+のうち .+で到着 · \d+分 余裕/)).toBeVisible();

  // タイムライン。電車を1本挟み、路線名は上流が返したものがそのまま出る
  // （ノード行と区間カードの2箇所に出るので先頭を見る）。
  await expect(page.getByText(fakeRailLine).first()).toBeVisible();
  await expect(page.getByText('徒歩').first()).toBeVisible();
});

test('上流へ渡す照会の中身が、画面で選んだ地点と一致する', async ({
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

  // 目的地の座標は autocomplete では返らず、確定時の details で補う2段フロー。
  expect(upstream.places.map((u) => u.searchParams.get('action'))).toContain(
    'details',
  );

  // 主照会（出発アンカー）。乗車駅探索の引き直しも同じ type なので、最初の1本を見る。
  const departure = upstream.guidance.filter(
    (u) => u.searchParams.get('type') === 'departure',
  )[0];

  expect(departure.searchParams.get('from')).toBe(
    `geo:${currentPosition.latitude},${currentPosition.longitude}`,
  );
  expect(departure.searchParams.get('to')).toBe(
    `geo:${destinationPlace.lat},${destinationPlace.lng}`,
  );
  expect(departure.searchParams.get('date')).toBe(todayInTokyo());
  expect(departure.searchParams.get('numItineraries')).toBe('5');

  // 主照会はバスを除く（#247）。バス優勢な区間で候補枠がバスに埋まるのを避ける指定で、
  // 落とすと電車候補が消える——画面には「ルートが見つかりません」としか出ない。
  expect(departure.searchParams.get('avoidModes')).toBe('bus,ferry,air');

  // 到着アンカーの第2波（#376）も出ている。並列に投げる設計なので、落ちると
  // 体感が上流1本ぶん遅くなるだけで、画面は何も言わない。
  expect(
    upstream.guidance.some((u) => u.searchParams.get('type') === 'arrival'),
  ).toBe(true);

  // 徒歩は実測している。マトリクスと個別実測のどちらも通らない検索は、直線推定の
  // まま確定した経路——実街路では大きく楽観に倒れる（#254）。
  expect(upstream.matrix.length).toBeGreaterThan(0);
  expect(upstream.walk.length).toBeGreaterThan(0);
});
