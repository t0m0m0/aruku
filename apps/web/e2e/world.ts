/// E2E が置く世界。偽の上流（fake-upstream.ts）と、それを見る spec の両方が読む。
///
/// 実在の地名・実在の Place ID は置かない。偽の応答が本物の地点を名乗ると、失敗した
/// ときに「上流が変わったのか、偽物が間違っているのか」が読めなくなる。

import type { FakePlace } from './upstream/fake-upstream';

/// ブラウザに持たせる現在地。東京駅あたり——実在の緯度経度を使うのは、エンジンが
/// 距離で分岐する（予算内に収まるか）ため。日本のどこかである必要がある。
export const currentPosition = { latitude: 35.6812, longitude: 139.7671 };

/// 目的地の候補。現在地から約 7.4km 離れている。
///
/// この距離に意味がある。全徒歩なら約 92 分で初期予算（60 分）を超え、電車を1本
/// 挟むと収まる——つまり「電車を使ってでも歩けるだけ歩く」という主導線が、
/// 偽の上流の作りではなく**距離**によって選ばれる。近すぎる目的地を置くと、
/// 経路が全徒歩へ畳まれて電車区間の描画を一度も通らない。
export const destinationPlace: FakePlace = {
  placeId: 'fake-place-destination',
  name: 'テスト公園',
  description: 'テスト公園, 東京都テスト区1-2-3',
  lat: 35.7295,
  lng: 139.7109,
};

/// 候補が2件以上あることを前提にする spec のための2件目。選んだ側だけが home へ
/// 入ることを反証できる。
export const otherPlace: FakePlace = {
  placeId: 'fake-place-other',
  name: 'テスト会館',
  description: 'テスト会館, 東京都テスト区4-5-6',
  lat: 35.7101,
  lng: 139.7702,
};

export const places: readonly FakePlace[] = [destinationPlace, otherPlace];
