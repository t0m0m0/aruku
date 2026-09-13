// 移植元: lib/core/models/recent_place.dart

import { GeoPoint } from '@aruku/engine/models/geo-point';

/// 検索履歴の1件。目的地・出発地のどちらの系統にも使う。
export interface RecentPlace {
  readonly name: string;
  readonly placeId: string | null;
  readonly latLng: GeoPoint | null;
  readonly address: string | null;

  /// 最後に使った時刻（UTC）。並びは保存順が持つので表示には使わないが、
  /// 将来のクラウド同期がマージの基準に要る。
  readonly usedAt: Date | null;
}

/// 同じ地点かの判定キー。placeId があればそれ、無ければ名前で寄せる。
///
/// 空文字の placeId を id 扱いしない。`'id:'` という1つのキーに畳まれ、placeId を
/// 持たない別々の地点が互いを追い出す。
export function dedupeKey(place: RecentPlace): string {
  const { placeId } = place;
  return placeId !== null && placeId !== '' ? `id:${placeId}` : `name:${place.name}`;
}

/// 永続化のための JSON。移植元と同じ形にしてある（キー名・null の落とし方とも）。
///
/// 値ごとに省略するのは、移植元が `if (x != null)` で組み立てていた形をそのまま
/// 運んだもの。読み側（[recentPlaceFromJson]）が欠落を許すので往復はする。
export function recentPlaceToJson(place: RecentPlace): Record<string, unknown> {
  return {
    name: place.name,
    ...(place.placeId !== null ? { placeId: place.placeId } : {}),
    ...(place.latLng !== null
      ? { lat: place.latLng.lat, lng: place.latLng.lng }
      : {}),
    ...(place.address !== null ? { address: place.address } : {}),
    ...(place.usedAt !== null ? { usedAt: place.usedAt.toISOString() } : {}),
  };
}

/// JSON から復元する。名前を欠くものは地点として意味を成さないので null を返し、
/// 呼び出し側（リポジトリ）が読み飛ばす。
///
/// 座標は lat/lng が**揃っている**ときだけ採る。片方だけの壊れた記録から
/// `GeoPoint(35.6, NaN)` を作ると、経路照会まで座標付きの顔をして届く。
export function recentPlaceFromJson(json: unknown): RecentPlace | null {
  if (typeof json !== 'object' || json === null) return null;
  const map = json as Record<string, unknown>;

  const name = map['name'];
  if (typeof name !== 'string') return null;

  const lat = map['lat'];
  const lng = map['lng'];
  const usedAt = map['usedAt'];
  const parsedUsedAt = typeof usedAt === 'string' ? new Date(usedAt) : null;

  return {
    name,
    placeId: typeof map['placeId'] === 'string' ? map['placeId'] : null,
    latLng:
      typeof lat === 'number' && typeof lng === 'number'
        ? new GeoPoint(lat, lng)
        : null,
    address: typeof map['address'] === 'string' ? map['address'] : null,
    // パースできない日付を Invalid Date のまま通さない。JSON へ書き戻す段で
    // toISOString() が RangeError を投げ、履歴の保存ごと落ちる。
    usedAt:
      parsedUsedAt !== null && !Number.isNaN(parsedUsedAt.getTime())
        ? parsedUsedAt
        : null,
  };
}
