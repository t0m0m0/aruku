// 移植元: flutter-final:lib/core/navigation/leg_handoff.dart（buildLegHandoffUri と
// legHandoffDestination）。
//
// 移植元は「いま案内中の区間」だけを開くので origin を省き、端末の現在地を出発地にさせて
// いた。Web は行程（JourneyProgress）を追跡せず全区間のリンクが同時に並ぶので、先の区間を
// 開いても現在地から引かれないよう、出発地も明示する（現在地から出る最初の区間を除く）。
//
// 移植元が徒歩区間に付けていた dir_action=navigate は付けない。出発地を明示すると、
// 現在地から離れた始点ではナビではなく経路プレビューに落ちる（Maps URLs の仕様）ので、
// 区間ごとに開き方が揺れるだけになる。

import type { GeoPoint } from '@aruku/engine/models/geo-point';
import { SegmentType, type RoutePlan } from '@aruku/engine/models/route-plan';

import { ja } from '../../i18n/ja';

/// [route] の [index] 番目の区間を Google マップで開く URL。行き先が決まらない区間は
/// null（空の destination で開くと目的地未設定の検索画面になる。移植元 #323）。
export function buildLegMapsUrl(route: RoutePlan, index: number): string | null {
  const leg = route.segments[index];
  if (leg === undefined) return null;
  const destination = legDestination(route, index);
  if (destination === null) return null;
  const origin = legOrigin(route, index);

  const query = new URLSearchParams({ api: '1' });
  if (origin !== null) query.set('origin', origin);
  query.set('destination', destination);
  // 電車・バスの depTime は載せられない。Maps URLs に出発時刻のパラメータが無く、
  // 乗換案内は Google マップ側の出発時刻選択に委ねる。
  query.set('travelmode', leg.type === SegmentType.walk ? 'walking' : 'transit');
  return `https://www.google.com/maps/dir/?${query.toString()}`;
}

// 名前より座標を先に見るのは、駅名に同名別駅があり Google マップ側の解決が揺れるため。
// 移植元は次区間の polyline の先頭へも落ちていたが、それは見ない（先頭を信用しない理由は
// legOrigin と同じ）。隣の区間の名前を見てよいのは segments が連結しているから。
function legDestination(route: RoutePlan, index: number): string | null {
  const leg = route.segments[index];
  const next = route.segments.at(index + 1);
  return (
    coordinate(leg.polyline.at(-1)) ??
    firstNonEmpty(leg.toName, next !== undefined ? next.fromName : route.to)
  );
}

// 区間自身の polyline の先頭は使わない。連続する徒歩を畳むとき、先頭側が geometry を
// 欠くと後ろ側の座標だけが残る（route-plan-builder の joinWalks）ので、先頭が区間の
// 途中を指し得る。末尾は終点であることが約束されているので、前の区間の末尾を使う。
function legOrigin(route: RoutePlan, index: number): string | null {
  const leg = route.segments[index];
  if (index === 0) return departureOrigin(route.from);
  const prev = route.segments[index - 1];
  return coordinate(prev.polyline.at(-1)) ?? firstNonEmpty(leg.fromName, prev.toName);
}

// 現在地から出るときは省き、端末の現在地を出発地にさせる。「現在地」は表示用の文言で、
// 地名として渡すと Google マップが別の場所を探す。それ以外の出発地は選んだ地点の名前。
function departureOrigin(from: string): string | null {
  if (from === ja.searchCurrentLocationName) return null;
  return firstNonEmpty(from);
}

function coordinate(point: GeoPoint | undefined): string | null {
  return point === undefined ? null : `${point.lat},${point.lng}`;
}

function firstNonEmpty(...names: string[]): string | null {
  return names.find((name) => name !== '') ?? null;
}
