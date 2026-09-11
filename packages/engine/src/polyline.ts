// 移植元: package:google_polyline_algorithm の `decodePolyline`。

/// Google Encoded Polyline Algorithm Format のデコード。連続する点の差分を
/// 1e5 倍の整数にし、5ビットずつ可変長で並べた形式を座標列へ戻す。
///
/// 依存を足さずに写したのは、実装が短く（アルゴリズムは公開仕様で固定）、この1関数の
/// ために npm 依存を増やす釣り合いが取れないため。徒歩プロキシ（Google Routes）の
/// `polyline.encodedPolyline` を読むのが唯一の用途。
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    lat += decodeValue();
    lng += decodeValue();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;

  function decodeValue(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    // 最下位ビットが符号。負なら全体を反転する（zigzag 符号化）。
    return (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
  }
}
