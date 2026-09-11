/// Dart の `num` が持っていて JavaScript の `Number` が持たない振る舞いのうち、
/// エンジンの出力に現れるもの。

/// Dart の `num.round()`（**0 から遠い方**へ丸める）に対応する。
///
/// `Math.round` は常に +∞ 方向へ丸めるので、負の .5 でずれる（Dart の
/// `(-2.5).round()` は -3、`Math.round(-2.5)` は -2）。負の所要分は壊れた上流データで
/// 実際に起こる——到着が発車より前の便を返されると `(arrSec - depSec) / 60` が負になる。
export function dartRound(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  // -0 を 0 へ均す。`-0 === 0` は真だが vitest の `toBe` は `Object.is` で見るため、
  // -0 のまま返すと「0 を期待」が落ちる。Dart の `round()` は int を返し -0 は無い。
  return rounded === 0 ? 0 : rounded;
}

/// Dart の `double.toString()` に対応する文字列化。
///
/// 整数値でも小数点を出す（Dart は `35.0`、JavaScript の `String(35)` は `35`）。
/// 上流へ送る `geo:35.0,139.0` / `origins=35.0,139.0` は**ワイヤーフォーマット**で、
/// 上流がどちらを受けるかはこちらが決められない。移植で書式が変われば送信内容が
/// 変わる（PORTING.md「意図的に揃えた点」）。
export function dartDouble(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
