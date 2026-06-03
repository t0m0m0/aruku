import 'package:flutter/foundation.dart';

import 'activity_snapshot.dart';

/// 1 日分の活動量（歩数）。距離・カロリーは歩数から [ActivitySnapshot] と
/// 同じ換算で導出するため、永続化するのは日付と歩数のみ（単一情報源）。
@immutable
class DailyActivity {
  DailyActivity({required DateTime date, required this.steps})
    : date = DateTime(date.year, date.month, date.day);

  factory DailyActivity.fromJson(Map<String, dynamic> json) {
    return DailyActivity(
      date: DateTime.parse(json['date'] as String),
      steps: json['steps'] as int,
    );
  }

  /// 年月日に正規化された日付（ローカルタイム、時刻は 00:00）。
  final DateTime date;
  final int steps;

  /// 歩数から導出した距離・カロリーのスナップショット。
  ActivitySnapshot get snapshot => ActivitySnapshot.fromSteps(steps);

  double get km => snapshot.km;
  int get kcal => snapshot.kcal;

  /// 永続化キーや比較に使う yyyy-MM-dd 形式の日付文字列。
  String get dateKey {
    final mm = date.month.toString().padLeft(2, '0');
    final dd = date.day.toString().padLeft(2, '0');
    return '${date.year}-$mm-$dd';
  }

  Map<String, dynamic> toJson() => {'date': dateKey, 'steps': steps};

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DailyActivity && date == other.date && steps == other.steps;

  @override
  int get hashCode => Object.hash(date, steps);
}
