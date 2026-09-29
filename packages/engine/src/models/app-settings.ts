// 移植元: flutter-final:lib/core/models/app_settings.dart（既定値は flutter-final:lib/core/constants/app_constants.dart）

/// ユーザー設定の永続化 JSON の形。
///
/// 今は呼ぶ側が無い——書き出し先だったクラウド同期は #285 で撤去し、Web の設定画面は
/// 永続化する設定を持たない。型ごと消すかは、使い道が戻るかと合わせて別に判断する。
/// `interface` ではなく型エイリアスにしてあるのは、`fromJson` が受ける
/// `Record<string, unknown>`（未検証の永続データ）へそのまま渡せるようにするため。
/// TypeScript は interface に暗黙の添字シグネチャを与えないので、interface のままだと
/// `fromJson(toJson())` のラウンドトリップが型で通らない。
export type AppSettingsJson = {
  notificationsEnabled: boolean;
  weeklyGoalKm: number;
  healthKitEnabled: boolean;
};

/// 週間ウォーキング目標距離（km）の既定値。
export const defaultWeeklyGoalKm = 10.0;

/// 設定画面で選べる週間目標のプリセット（km、昇順）。
export const weeklyGoalPresetsKm: readonly number[] = [5.0, 10.0, 15.0, 20.0, 30.0];

export interface AppSettingsInit {
  notificationsEnabled?: boolean;
  weeklyGoalKm?: number;
  healthKitEnabled?: boolean;
}

/// ユーザーが設定画面で変更できるアプリ設定。永続化は JSON（[toJson]/[fromJson]）。
export class AppSettings {
  constructor(init: AppSettingsInit = {}) {
    this.notificationsEnabled = init.notificationsEnabled ?? true;
    this.weeklyGoalKm = init.weeklyGoalKm ?? defaultWeeklyGoalKm;
    this.healthKitEnabled = init.healthKitEnabled ?? false;
  }

  /// 通知の許可フラグ。
  readonly notificationsEnabled: boolean;

  /// 週間ウォーキング目標距離（km）。常に正の値。
  readonly weeklyGoalKm: number;

  /// HealthKit（Apple ヘルスケア）連携の有効フラグ。オプトインのため既定はオフ。
  readonly healthKitEnabled: boolean;

  static readonly defaults = new AppSettings();

  copyWith(patch: AppSettingsInit = {}): AppSettings {
    return new AppSettings({
      notificationsEnabled:
        patch.notificationsEnabled ?? this.notificationsEnabled,
      weeklyGoalKm: patch.weeklyGoalKm ?? this.weeklyGoalKm,
      healthKitEnabled: patch.healthKitEnabled ?? this.healthKitEnabled,
    });
  }

  /// 常に全キーを出力する。
  toJson(): AppSettingsJson {
    return {
      notificationsEnabled: this.notificationsEnabled,
      weeklyGoalKm: this.weeklyGoalKm,
      healthKitEnabled: this.healthKitEnabled,
    };
  }

  static fromJson(json: Record<string, unknown>): AppSettings {
    const notifications = json['notificationsEnabled'];
    const goal = json['weeklyGoalKm'];
    const healthKit = json['healthKitEnabled'];
    return new AppSettings({
      notificationsEnabled:
        typeof notifications === 'boolean'
          ? notifications
          : AppSettings.defaults.notificationsEnabled,
      // 破損・不正値（非数値・0以下）は既定値へフォールバックする。
      weeklyGoalKm:
        typeof goal === 'number' && goal > 0
          ? goal
          : AppSettings.defaults.weeklyGoalKm,
      healthKitEnabled:
        typeof healthKit === 'boolean'
          ? healthKit
          : AppSettings.defaults.healthKitEnabled,
    });
  }

  /// Dart 版の `==` に対応する。TypeScript には演算子多重定義が無いので、値の同一性を
  /// 問う箇所はこれを呼ぶ（`toEqual` の構造比較でも同じ結果になるが、移植元が明示的な
  /// 等値を持つ型なのでそれを残す）。
  equals(other: AppSettings): boolean {
    return (
      this.notificationsEnabled === other.notificationsEnabled &&
      this.weeklyGoalKm === other.weeklyGoalKm &&
      this.healthKitEnabled === other.healthKitEnabled
    );
  }
}
