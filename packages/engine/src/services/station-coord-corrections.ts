import { GeoPoint } from '../models/geo-point';
import { stationCoordTable } from './station-coord-table';

/// Transit API が返す駅座標のうち、実際の駅から大きくずれているものと、その正しい座標（#515）。
export interface StationCoordCorrection {
  /// 表を読む人のための駅 id。突き合わせには使わない（[from] で引く）。
  readonly station: string;
  readonly name: string;
  /// Transit API が返す、ずれた座標 [緯度, 経度]。
  readonly from: readonly [number, number];
  /// 正しい座標 [緯度, 経度]。
  readonly to: readonly [number, number];
  readonly offsetM: number;
}

// 駅 id ではなくずれた座標で引く。停車駅を結んだ polyline の途中の頂点は id を持たず、
// id で引くと上流が座標を直した後も古い補正先へ動かし続けてしまう。
const coordKey = (lat: number, lng: number): string =>
  `${lat.toFixed(5)},${lng.toFixed(5)}`;

const correctedByRawCoord = new Map<string, GeoPoint>(
  stationCoordTable.map((r) => [
    coordKey(r.from[0], r.from[1]),
    new GeoPoint(r.to[0], r.to[1]),
  ]),
);

/// [p] が補正表に載ったずれた駅座標なら正しい座標を、そうでなければ null を返す。
export function correctStationCoord(p: GeoPoint): GeoPoint | null {
  return correctedByRawCoord.get(coordKey(p.lat, p.lng)) ?? null;
}
