import 'package:aruku/core/models/app_settings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults は通知オン', () {
    const s = AppSettings.defaults;
    expect(s.notificationsEnabled, isTrue);
  });

  test('copyWith は指定項目のみ差し替える', () {
    const s = AppSettings.defaults;
    final next = s.copyWith(notificationsEnabled: false);
    expect(next.notificationsEnabled, isFalse);
  });

  test('toJson / fromJson でラウンドトリップする', () {
    const s = AppSettings(notificationsEnabled: false);
    expect(AppSettings.fromJson(s.toJson()), s);
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
