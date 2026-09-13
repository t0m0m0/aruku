// 移植元: lib/features/search/place_selection.dart

import type { PlacePrediction } from './place-prediction';
import type { PlacesService } from './places-service';
import type { RecentPlace } from './recent-place';

/// 候補を確定できる地点へ解決する。座標を引けなければ null。
///
/// 全画面検索とデスクトップのタイプアヘッドが同じ規則で確定するよう、画面から
/// 切り離して1つに置く。片側だけ直すと「ある入口からだけ座標なしの目的地が入る」
/// 形で壊れ、経路照会まで届かない。
export async function resolvePlacePrediction(
  service: PlacesService,
  prediction: PlacePrediction,
): Promise<RecentPlace | null> {
  // Google autocomplete は座標を返さないため、確定時に details で座標を引く。
  // オフライン時の TypeError など PlacesException 以外も座標なし扱いにする
  // （取りこぼすと呼び出し側の選択中フラグが立ったままリストが固まる）。
  let latLng;
  try {
    latLng = await service.fetchLatLng(prediction.placeId);
  } catch {
    latLng = null;
  }
  // 経路照会（/guidance/plan）は from/to ともに座標必須。
  // 座標が取れない候補は確定させず、別候補の再選択を促す。
  if (latLng === null) return null;

  // usedAt は履歴へ入れる側（リポジトリ）が打つ。ここで打つと、確定した時刻と
  // 記録した時刻という2つの意味が1つの項目に混ざる。
  return {
    name: prediction.name,
    placeId: prediction.placeId,
    latLng,
    address: prediction.address,
    usedAt: null,
  };
}
