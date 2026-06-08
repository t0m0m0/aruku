import 'package:aruku/core/models/app_settings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults は km・通知オン・予算60分', () {
    const s = AppSettings.defaults;
    expect(s.unit, DistanceUnit.kilometers);
    expect(s.notificationsEnabled, isTrue);
    expect(s.defaultBudgetMinutes, 60);
  });

  test('copyWith は指定項目のみ差し替える', () {
    const s = AppSettings.defaults;
    final next = s.copyWith(unit: DistanceUnit.miles, defaultBudgetMinutes: 90);
    expect(next.unit, DistanceUnit.miles);
    expect(next.defaultBudgetMinutes, 90);
    // 未指定は据え置き。
    expect(next.notificationsEnabled, s.notificationsEnabled);
  });

  test('toJson / fromJson でラウンドトリップする', () {
    const s = AppSettings(
      unit: DistanceUnit.miles,
      notificationsEnabled: false,
      defaultBudgetMinutes: 120,
    );
    expect(AppSettings.fromJson(s.toJson()), s);
  });

  test('不明な単位文字列は km にフォールバックする', () {
    final s = AppSettings.fromJson(const {
      'unit': 'parsec',
      'notificationsEnabled': true,
      'defaultBudgetMinutes': 60,
    });
    expect(s.unit, DistanceUnit.kilometers);
  });

  test('欠損フィールドは defaults を採用する', () {
    final s = AppSettings.fromJson(const {});
    expect(s, AppSettings.defaults);
  });

  test('値が等しければ == で等価', () {
    expect(
      const AppSettings(defaultBudgetMinutes: 45),
      const AppSettings(defaultBudgetMinutes: 45),
    );
  });
}
