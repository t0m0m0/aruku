import 'package:flutter/foundation.dart';

@immutable
class TimeValue {
  const TimeValue({
    required this.h,
    required this.m,
    this.isNow = false,
    this.dateOffset = 0,
  }) : assert(dateOffset >= 0);

  /// 0–23
  final int h;

  /// 0–59 (typically multiples of 5)
  final int m;

  /// Departure side: "current time" — auto-derived.
  final bool isNow;

  /// 今日からの日数オフセット。0 = 今日, 1 = 明日, n = n日後。
  /// isNow=true のときは無視される。
  final int dateOffset;

  int get totalMinutes => h * 60 + m;

  TimeValue copyWith({int? h, int? m, bool? isNow, int? dateOffset}) =>
      TimeValue(
        h: h ?? this.h,
        m: m ?? this.m,
        isNow: isNow ?? this.isNow,
        dateOffset: dateOffset ?? this.dateOffset,
      );

  String format() =>
      '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';

  /// この出発／到着が指す絶対日付のラベル「M月D日 (曜)」。当日でも省略せず必ず返す。
  /// isNow=true は「今すぐ」なので当日扱い（dateOffset は無視）。経路結果画面ヘッダーの
  /// ように、実際に検索した日付を常に明示したい箇所で使う（[dateLabel] は当日を null に
  /// するため不可）。
  String fullDateLabel({DateTime? now}) {
    final base = now ?? DateTime.now();
    final offset = isNow ? 0 : dateOffset;
    final d = DateTime(base.year, base.month, base.day + offset);
    const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
    return '${d.month}月${d.day}日 (${weekdays[d.weekday - 1]})';
  }

  /// ホーム画面に出す日付ラベル。当日・「今すぐ」は表示しない（null）。
  /// 翌日は「明日」、それ以降は「M/D(曜)」。
  String? dateLabel({DateTime? now}) {
    if (isNow || dateOffset == 0) return null;
    if (dateOffset == 1) return '明日';
    final base = now ?? DateTime.now();
    final d = DateTime(base.year, base.month, base.day + dateOffset);
    const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
    return '${d.month}/${d.day}(${weekdays[d.weekday - 1]})';
  }

  static String formatBudget(int minutes) {
    if (minutes <= 0) return '— ';
    final h = minutes ~/ 60;
    final m = minutes % 60;
    if (h > 0) return '$h時間 ${m.toString().padLeft(2, '0')}分';
    return '$m分';
  }

  static String formatBudgetJp(int minutes) {
    if (minutes <= 0) return '— ';
    final h = minutes ~/ 60;
    final m = minutes % 60;
    if (h > 0) return '$h時間 ${m.toString().padLeft(2, '0')}分';
    return '$m分';
  }
}

enum PickerMode { depart, arrival }

/// 出発・到着に指定できる先の上限（今日からの日数）。
///
/// ホイールシートとデスクトップの日付ステッパーが同じ範囲を出すよう、
/// 値はここだけに置く。片方だけ広いと、一方の入口でしか作れない状態が
/// できて再現条件が読めなくなる。
const int kMaxDateOffsetDays = 90;

/// カレンダーが返す絶対日付を [TimeValue.dateOffset]（今日からの日数）へ直す。
///
/// ホイールシートとデスクトップのカレンダーで別々に書かない。片方だけ丸めを
/// 落とすと、範囲外の日付が [TimeValue] の `assert(dateOffset >= 0)` まで
/// 素通りして、入口ではなくモデルの構築時に落ちる。
///
/// 日付どうしの差は UTC へ置き換えてから取る。ローカル時刻のままだと、夏時間の
/// 切り替わりを挟む1日が23時間となり `inDays` が 0 を返す。
int dateOffsetFrom({required DateTime picked, required DateTime now}) {
  final today = DateTime.utc(now.year, now.month, now.day);
  final target = DateTime.utc(picked.year, picked.month, picked.day);
  return target.difference(today).inDays.clamp(0, kMaxDateOffsetDays);
}
