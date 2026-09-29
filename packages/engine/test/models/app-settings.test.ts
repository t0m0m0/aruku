// 移植元: flutter-final:test/core/models/app_settings_test.dart

import { expect, it } from 'vitest';

import {
  AppSettings,
  defaultWeeklyGoalKm,
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
