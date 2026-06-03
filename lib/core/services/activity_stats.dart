import '../models/daily_activity.dart';

/// 活動日とみなす最小歩数。これ未満の日は連続記録に数えない。
const int kStreakMinSteps = 1;

DateTime _dateOnly(DateTime d) => DateTime(d.year, d.month, d.day);

/// [history] から [today] 時点の連続活動日数を算出する。
///
/// 最新の活動日が今日か昨日であれば、その日から過去へ連続して活動した
/// 日数を返す。今日がまだ未計測でも昨日からの連続記録は途切れさせない。
int computeStreak(
  Iterable<DailyActivity> history,
  DateTime today, {
  int minSteps = kStreakMinSteps,
}) {
  final active = <DateTime>{
    for (final e in history)
      if (e.steps >= minSteps) _dateOnly(e.date),
  };
  if (active.isEmpty) return 0;

  final todayDate = _dateOnly(today);
  // 今日が未計測なら昨日を起点にする（進行中の今日で連続を切らない）。
  var cursor = active.contains(todayDate)
      ? todayDate
      : todayDate.subtract(const Duration(days: 1));

  var streak = 0;
  while (active.contains(cursor)) {
    streak++;
    cursor = cursor.subtract(const Duration(days: 1));
  }
  return streak;
}

/// [today] を含む今週（月曜起点）の合計距離（km）。
double weekKm(Iterable<DailyActivity> history, DateTime today) {
  final todayDate = _dateOnly(today);
  // weekday は月=1..日=7。月曜の 00:00 を週初めとする。
  final monday = todayDate.subtract(Duration(days: todayDate.weekday - 1));
  var total = 0.0;
  for (final e in history) {
    final d = _dateOnly(e.date);
    if (!d.isBefore(monday) && !d.isAfter(todayDate)) {
      total += e.km;
    }
  }
  return total;
}
