import 'package:aruku/core/constants/app_constants.dart';
import 'package:aruku/core/models/app_settings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults は通知オン・週間目標 10km・HealthKit連携オフ', () {
    const s = AppSettings.defaults;
    expect(s.notificationsEnabled, isTrue);
    expect(s.weeklyGoalKm, AppConstants.weeklyGoalKm);
    expect(s.healthKitEnabled, isFalse);
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
    expect(s.copyWith(healthKitEnabled: true).healthKitEnabled, isTrue);
    expect(s.copyWith(healthKitEnabled: true).notificationsEnabled, isTrue);
  });

  test('toJson / fromJson でラウンドトリップする', () {
    const s = AppSettings(
      notificationsEnabled: false,
      weeklyGoalKm: 15,
      healthKitEnabled: true,
    );
    expect(AppSettings.fromJson(s.toJson()), s);
  });

  test('healthKitEnabled 欠損・非boolは false にフォールバック', () {
    expect(AppSettings.fromJson(const {}).healthKitEnabled, isFalse);
    expect(
      AppSettings.fromJson(const {'healthKitEnabled': 'x'}).healthKitEnabled,
      isFalse,
    );
  });

  test('healthKitEnabled が違えば == で非等価', () {
    expect(
      const AppSettings(healthKitEnabled: true),
      isNot(const AppSettings()),
    );
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

  group('firestore.rules との同期スキーマ契約', () {
    // firestore.rules の isValidSettings が許可するキー集合。これが崩れると
    // 同期書き込みが PERMISSION_DENIED になる（#257）。フィールドを足すときは
    // firestore.rules と functions/test/firestore-rules.test.ts も同時に直す。
    test('toJson のキー集合はルールの許可キーと厳密に一致する', () {
      expect(AppSettings.defaults.toJson().keys.toSet(), {
        'notificationsEnabled',
        'weeklyGoalKm',
        'healthKitEnabled',
      });
    });

    test('toJson は常に全キーを出力する（ルールが hasAll を課すため）', () {
      const s = AppSettings(
        notificationsEnabled: false,
        weeklyGoalKm: 30,
        healthKitEnabled: true,
      );
      expect(s.toJson().values, isNot(contains(null)));
      expect(s.toJson().length, 3);
    });

    test('週間目標プリセットはすべてルールの許可範囲(0 < km <= 1000)に収まる', () {
      for (final km in AppConstants.weeklyGoalPresetsKm) {
        expect(km, greaterThan(0));
        expect(km, lessThanOrEqualTo(1000));
      }
    });
  });
}
