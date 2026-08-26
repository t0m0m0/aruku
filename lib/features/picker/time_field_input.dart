/// キー入力できる時刻フィールド（デスクトップ幅）の入力解釈。
///
/// モバイルのホイールシートは値域を UI 側で閉じ込められるが、キー入力は
/// 任意の文字列が来る。解釈の規則をここへ集約し、ウィジェットから切り離して
/// 単体で反証できるようにする。#372 参照。
library;

/// 時刻を1回動かす刻み（分）。
const int kTimeStepMinutes = 5;

const int _minutesPerDay = 24 * 60;

/// 入力文字列を時刻として解釈する。数字が1つも無ければ null。
///
/// 区切り文字で分岐せず数字だけを見るのは、`9:32` `0932` `9時32分` を同じ
/// 結果に畳むため。全角コロンや打ち損じごとに経路が増えるのを避ける。
({int h, int m})? parseTimeInput(String raw) {
  var digits = raw.replaceAll(RegExp('[^0-9]'), '');
  if (digits.isEmpty) return null;
  // HH:MM は4桁で表しきれる。超えた分は打ち直しの途中とみなして末尾を採る。
  if (digits.length > 4) {
    digits = digits.substring(digits.length - 4);
  }
  final split = digits.length <= 2 ? 0 : digits.length - 2;
  final h = split == 0 ? 0 : int.parse(digits.substring(0, split));
  final m = int.parse(digits.substring(split));
  return (h: h.clamp(0, 23), m: m.clamp(0, 59));
}

/// [totalMinutes] を [step] 分動かす。日の端は折り返す。
///
/// 端で止めないのは、23:58 から上へ動かせない行き止まりを作らないため。
int stepTotalMinutes(int totalMinutes, int step) =>
    ((totalMinutes + step) % _minutesPerDay + _minutesPerDay) % _minutesPerDay;
