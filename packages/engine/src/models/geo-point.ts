// 移植元: lib/core/models/geo_point.dart

/// 緯度経度。[heading] は進行方向（度、真北基準）で、取得できない場合は null。
///
/// Dart 版は `==`/`hashCode` から [heading] を外している（位置の同一性に含めない）。
/// TypeScript には演算子多重定義が無く、vitest の `toEqual` は構造比較なので
/// [heading] も比較対象に入る。#384 の移植対象6ファイルは [heading] を一切使わない
/// ため両者は一致するが、[heading] を持つ点の等値比較を書くときはここが食い違う。
/// エンジン内で Dart の `==` と同じ判定が要る箇所は [isAt] を使う。
export class GeoPoint {
  constructor(
    readonly lat: number,
    readonly lng: number,
    readonly heading: number | null = null,
  ) {}

  /// Dart 版の `==` に対応する「同じ地点か」。[heading] は見ない——進行方向は
  /// 位置の同一性ではなく、同じ地点を別の向きで通っただけの点を別物にしてしまう。
  ///
  /// メソッドにしているのでインスタンスの**自前プロパティ**は増えず、`toEqual` の
  /// 構造比較（上記の食い違い）には影響しない。
  isAt(other: GeoPoint): boolean {
    return this.lat === other.lat && this.lng === other.lng;
  }
}
