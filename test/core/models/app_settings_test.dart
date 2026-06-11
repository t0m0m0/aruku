import 'package:aruku/core/models/app_settings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults は km・通知オン', () {
    const s = AppSettings.defaults;
    expect(s.unit, DistanceUnit.kilometers);
    expect(s.notificationsEnabled, isTrue);
  });

  test('copyWith は指定項目のみ差し替える', () {
    const s = AppSettings.defaults;
    final next = s.copyWith(unit: DistanceUnit.miles);
    expect(next.unit, DistanceUnit.miles);
    // 未指定は据え置き。
    expect(next.notificationsEnabled, s.notificationsEnabled);
  });

  test('toJson / fromJson でラウンドトリップする', () {
    const s = AppSettings(
      unit: DistanceUnit.miles,
      notificationsEnabled: false,
    );
    expect(AppSettings.fromJson(s.toJson()), s);
  });

  test('不明な単位文字列は km にフォールバックする', () {
    final s = AppSettings.fromJson(const {
      'unit': 'parsec',
      'notificationsEnabled': true,
    });
    expect(s.unit, DistanceUnit.kilometers);
  });

  test('欠損フィールドは defaults を採用する', () {
    final s = AppSettings.fromJson(const {});
    expect(s, AppSettings.defaults);
  });

  test('値が等しければ == で等価', () {
    expect(
      const AppSettings(notificationsEnabled: false),
      const AppSettings(notificationsEnabled: false),
    );
  });
}
