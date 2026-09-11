// 移植元: test/core/models/app_settings_test.dart
//
// #384 の6ファイルはサービス層で、AppSettings に一度も触れない。この型は
// `firestore.rules` と同じ契約の片側（#257）で、#385 で TS へ一本化した目的が
// 「片方だけ変わる事故を型と失敗するテストで止める」ことなので、移植元のテストを運ぶ。

import { describe, expect, it } from 'vitest';

import {
  AppSettings,
  defaultWeeklyGoalKm,
  weeklyGoalPresetsKm,
} from '../../src/models/app-settings';

it('defaults は通知オン・週間目標 10km・HealthKit連携オフ', () => {
  const s = AppSettings.defaults;
  expect(s.notificationsEnabled).toBe(true);
  expect(s.weeklyGoalKm).toBe(defaultWeeklyGoalKm);
  expect(s.healthKitEnabled).toBe(false);
});

it('copyWith は指定項目のみ差し替える', () => {
  const s = AppSettings.defaults;
  expect(s.copyWith({ notificationsEnabled: false }).notificationsEnabled).toBe(
    false,
  );
  expect(s.copyWith({ notificationsEnabled: false }).weeklyGoalKm).toBe(
    s.weeklyGoalKm,
  );
  expect(s.copyWith({ weeklyGoalKm: 20 }).weeklyGoalKm).toBe(20);
  expect(s.copyWith({ weeklyGoalKm: 20 }).notificationsEnabled).toBe(true);
  expect(s.copyWith({ healthKitEnabled: true }).healthKitEnabled).toBe(true);
  expect(s.copyWith({ healthKitEnabled: true }).notificationsEnabled).toBe(true);
});

it('toJson / fromJson でラウンドトリップする', () => {
  const s = new AppSettings({
    notificationsEnabled: false,
    weeklyGoalKm: 15,
    healthKitEnabled: true,
  });
  expect(AppSettings.fromJson(s.toJson()).equals(s)).toBe(true);
});

it('healthKitEnabled 欠損・非boolは false にフォールバック', () => {
  expect(AppSettings.fromJson({}).healthKitEnabled).toBe(false);
  expect(
    AppSettings.fromJson({ healthKitEnabled: 'x' }).healthKitEnabled,
  ).toBe(false);
});

it('healthKitEnabled が違えば == で非等価', () => {
  expect(
    new AppSettings({ healthKitEnabled: true }).equals(new AppSettings()),
  ).toBe(false);
});

it('欠損フィールドは defaults を採用する', () => {
  const s = AppSettings.fromJson({});
  expect(s.equals(AppSettings.defaults)).toBe(true);
});

it('不正な週間目標（0以下・非数値）は defaults にフォールバック', () => {
  expect(AppSettings.fromJson({ weeklyGoalKm: 0 }).weeklyGoalKm).toBe(
    defaultWeeklyGoalKm,
  );
  expect(AppSettings.fromJson({ weeklyGoalKm: -5 }).weeklyGoalKm).toBe(
    defaultWeeklyGoalKm,
  );
  expect(AppSettings.fromJson({ weeklyGoalKm: 'x' }).weeklyGoalKm).toBe(
    defaultWeeklyGoalKm,
  );
});

// Dart は int と double を分けるが JavaScript の number は1つなので、移植元が
// 固定していた「int でも double として読める」は型の上では自明になる。値として
// 12 が通ることの確認だけ残す。
it('週間目標は int でも double として読める', () => {
  expect(AppSettings.fromJson({ weeklyGoalKm: 12 }).weeklyGoalKm).toBe(12.0);
});

it('値が等しければ == で等価', () => {
  expect(
    new AppSettings({ notificationsEnabled: false, weeklyGoalKm: 15 }).equals(
      new AppSettings({ notificationsEnabled: false, weeklyGoalKm: 15 }),
    ),
  ).toBe(true);
});

it('週間目標が違えば == で非等価', () => {
  expect(
    new AppSettings({ weeklyGoalKm: 10 }).equals(
      new AppSettings({ weeklyGoalKm: 20 }),
    ),
  ).toBe(false);
});

describe('firestore.rules との同期スキーマ契約', () => {
  // firestore.rules の isValidSettings が許可するキー集合。これが崩れると
  // 同期書き込みが PERMISSION_DENIED になる（#257）。フィールドを足すときは
  // firestore.rules と functions/test/firestore-rules.test.ts も同時に直す。
  it('toJson のキー集合はルールの許可キーと厳密に一致する', () => {
    expect(new Set(Object.keys(AppSettings.defaults.toJson()))).toEqual(
      new Set(['notificationsEnabled', 'weeklyGoalKm', 'healthKitEnabled']),
    );
  });

  it('toJson は常に全キーを出力する（ルールが hasAll を課すため）', () => {
    const s = new AppSettings({
      notificationsEnabled: false,
      weeklyGoalKm: 30,
      healthKitEnabled: true,
    });
    expect(Object.values(s.toJson())).not.toContain(null);
    expect(Object.keys(s.toJson())).toHaveLength(3);
  });

  it('週間目標プリセットはすべてルールの許可範囲(0 < km <= 1000)に収まる', () => {
    for (const km of weeklyGoalPresetsKm) {
      expect(km).toBeGreaterThan(0);
      expect(km).toBeLessThanOrEqual(1000);
    }
  });
});
