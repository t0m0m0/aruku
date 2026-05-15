import 'package:flutter/foundation.dart';

@immutable
class TimeValue {
  const TimeValue({
    required this.h,
    required this.m,
    this.isNow = false,
    this.anchored = false,
  });

  /// 0–23
  final int h;

  /// 0–59 (typically multiples of 5)
  final int m;

  /// Departure side: "current time" — auto-derived.
  final bool isNow;

  /// True for the side that the user explicitly anchored.
  final bool anchored;

  int get totalMinutes => h * 60 + m;

  TimeValue copyWith({int? h, int? m, bool? isNow, bool? anchored}) =>
      TimeValue(
        h: h ?? this.h,
        m: m ?? this.m,
        isNow: isNow ?? this.isNow,
        anchored: anchored ?? this.anchored,
      );

  String format() =>
      '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';

  static String formatBudget(int minutes) {
    if (minutes <= 0) return '— ';
    final h = minutes ~/ 60;
    final m = minutes % 60;
    if (h > 0) return '${h}h ${m.toString().padLeft(2, '0')}m';
    return '${m}m';
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
