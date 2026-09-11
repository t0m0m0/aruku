/// Dart の `double.toString()` に対応する文字列化。
///
/// JavaScript の `String(35.0)` は `"35"` だが Dart は `"35.0"` を返す。エンジンが上流へ
/// 送る `geo:35.0,139.0` はワイヤーフォーマットなので、期待値を組み立てるテスト側も
/// 同じ書式でなければ「送信内容が変わったのに緑のまま」になる（PORTING.md 参照）。
export function dartDouble(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
