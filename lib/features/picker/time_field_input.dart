/// キー入力できる時刻フィールド（デスクトップ幅）の入力解釈。
///
/// モバイルのホイールシートは値域を UI 側で閉じ込められるが、キー入力は
/// 任意の文字列が来る。解釈の規則をここへ集約し、ウィジェットから切り離して
/// 単体で反証できるようにする。#372 参照。
library;

/// 時刻を1回動かす刻み（分）。
const int kTimeStepMinutes = 5;

const int _minutesPerDay = 24 * 60;

/// 数字列を1つだけ区切る「時と分」の並び。`9:32` `9時32分` `  09 : 32 ` に当たる。
final _separated = RegExp(r'^\D*(\d+)\D+(\d+)\D*$');

/// 入力文字列を時刻として解釈する。数字が1つも無ければ null。
///
/// 区切りの有無で規則を変えるのは、下2桁を分とする規則だけでは `12:3` が
/// 01:23 になり、打ち終える前の値が別の時刻として確定してしまうため。
/// 区切りが打たれているならそこが時と分の境界であり、それ以上に信頼できる
/// 手がかりは無い。区切りの種類（`:` 全角コロン `時`）は問わない。
({int h, int m})? parseTimeInput(String raw) {
  final separated = _separated.firstMatch(raw);
  if (separated != null) {
    return _clamped(
      int.parse(separated.group(1)!),
      int.parse(separated.group(2)!),
    );
  }

  var digits = raw.replaceAll(RegExp('[^0-9]'), '');
  if (digits.isEmpty) return null;
  // HH:MM は4桁で表しきれる。超えた分は打ち直しの途中とみなして末尾を採る。
  if (digits.length > 4) {
    digits = digits.substring(digits.length - 4);
  }
  final split = digits.length <= 2 ? 0 : digits.length - 2;
  final h = split == 0 ? 0 : int.parse(digits.substring(0, split));
  return _clamped(h, int.parse(digits.substring(split)));
}

({int h, int m}) _clamped(int h, int m) =>
    (h: h.clamp(0, 23), m: m.clamp(0, 59));

/// [totalMinutes] を [step] 分動かした結果と、その際にまたいだ日数。
///
/// 日跨ぎを呼び出し側へ返すのは、時刻だけ折り返して日付を据え置くと
/// 23:58 の5分後が「同日の 00:03」になるため。到着が翌日のままなら
/// 1時間の予算が25時間近くへ膨らむ。時刻と日付は必ず一緒に動かす。
({int totalMinutes, int dayDelta}) stepTotalMinutes(
  int totalMinutes,
  int step,
) {
  final moved = totalMinutes + step;
  final dayDelta = (moved / _minutesPerDay).floor();
  return (totalMinutes: moved - dayDelta * _minutesPerDay, dayDelta: dayDelta);
}
