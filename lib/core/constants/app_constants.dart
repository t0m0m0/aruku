class AppConstants {
  AppConstants._();

  static const int weeklyKcalEstimate = 1840;

  /// 週間ウォーキング目標距離（km）。
  static const double weeklyGoalKm = 10.0;

  static String todayDateLabel() {
    final now = DateTime.now();
    const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
    final day = weekdays[now.weekday - 1];
    return '${now.month}月${now.day}日 ($day)';
  }

  static String todayGreeting() {
    final now = DateTime.now();
    final greeting = now.hour < 12
        ? 'おはようございます'
        : now.hour < 18
        ? 'こんにちは'
        : 'こんばんは';
    return '${todayDateLabel()} · $greeting';
  }
}
