import 'package:aruku/core/constants/app_constants.dart';
import 'package:aruku/core/models/app_settings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults は通知オン・週間目標 10km', () {
    const s = AppSettings.defaults;
    expect(s.notificationsEnabled, isTrue);
    expect(s.weeklyGoalKm, AppConstants.weeklyGoalKm);
  });

  test('copyWith は指定項目のみ差し替える', () {
    const s = AppSettings.defaults;
    expect(
      s.copyWith(notificationsEnabled: false).notificationsEnabled,
      isFalse,
    );
    expect(
      s.copyWith(notificationsEnabled: false).weeklyGoalKm,
      s.weeklyGoalKm,
    );
    expect(s.copyWith(weeklyGoalKm: 20).weeklyGoalKm, 20);
    expect(s.copyWith(weeklyGoalKm: 20).notificationsEnabled, isTrue);
  });

  test('toJson / fromJson でラウンドトリップする', () {
    const s = AppSettings(notificationsEnabled: false, weeklyGoalKm: 15);
    expect(AppSettings.fromJson(s.toJson()), s);
  });

  test('欠損フィールドは defaults を採用する', () {
    final s = AppSettings.fromJson(const {});
    expect(s, AppSettings.defaults);
  });

  test('不正な週間目標（0以下・非数値）は defaults にフォールバック', () {
    expect(
      AppSettings.fromJson(const {'weeklyGoalKm': 0}).weeklyGoalKm,
      AppConstants.weeklyGoalKm,
    );
    expect(
      AppSettings.fromJson(const {'weeklyGoalKm': -5}).weeklyGoalKm,
      AppConstants.weeklyGoalKm,
    );
    expect(
      AppSettings.fromJson(const {'weeklyGoalKm': 'x'}).weeklyGoalKm,
      AppConstants.weeklyGoalKm,
    );
  });

  test('週間目標は int でも double として読める', () {
    expect(AppSettings.fromJson(const {'weeklyGoalKm': 12}).weeklyGoalKm, 12.0);
  });

  test('値が等しければ == で等価', () {
    expect(
      const AppSettings(notificationsEnabled: false, weeklyGoalKm: 15),
      const AppSettings(notificationsEnabled: false, weeklyGoalKm: 15),
    );
  });

  test('週間目標が違えば == で非等価', () {
    expect(
      const AppSettings(weeklyGoalKm: 10),
      isNot(const AppSettings(weeklyGoalKm: 20)),
    );
  });
}
