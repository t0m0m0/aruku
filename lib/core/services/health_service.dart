import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// HealthKit（Apple ヘルスケア）へ書き込む歩行セッションのワークアウト。
@immutable
class WalkingWorkout {
  const WalkingWorkout({
    required this.start,
    required this.end,
    required this.steps,
    required this.km,
    required this.kcal,
  });

  /// セッション開始時刻。
  final DateTime start;

  /// セッション終了時刻。
  final DateTime end;

  /// セッション中の歩数。
  final int steps;

  /// セッション中の距離（km）。
  final double km;

  /// セッション中の消費カロリー（kcal）。
  final int kcal;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is WalkingWorkout &&
          start == other.start &&
          end == other.end &&
          steps == other.steps &&
          km == other.km &&
          kcal == other.kcal;

  @override
  int get hashCode => Object.hash(start, end, steps, km, kcal);
}

/// HealthKit 等の健康データストアとの連携サービス。
///
/// 既定実装は [NoopHealthService]（何もしない）。実機ビルドでのみ
/// `health` パッケージを用いた実体を注入し、[healthServiceProvider] を上書きする。
abstract interface class HealthService {
  /// 連携に必要な権限を要求する。許可されたら true。
  Future<bool> requestAuthorization();

  /// 歩行セッション [workout] をワークアウトとして書き込む。成功したら true。
  Future<bool> writeWalkingWorkout(WalkingWorkout workout);
}

/// 連携先を持たない既定実装。プラグイン未導入の環境（テスト・Android・
/// シミュレータ）で安全に no-op として振る舞う。
class NoopHealthService implements HealthService {
  const NoopHealthService();

  @override
  Future<bool> requestAuthorization() async => false;

  @override
  Future<bool> writeWalkingWorkout(WalkingWorkout workout) async => false;
}

final healthServiceProvider = Provider<HealthService>(
  (_) => const NoopHealthService(),
);
