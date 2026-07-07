import 'package:health/health.dart';

import 'health_service.dart';

/// `health` パッケージ（iOS は HealthKit）を用いた [HealthService] の実体。
///
/// ワークアウトの書き込みのみを行い、歩数の読み取りは pedometer に任せるため
/// 権限は WORKOUT の WRITE のみを要求する（最小権限）。
class HealthKitService implements HealthService {
  HealthKitService({Health? health}) : _health = health ?? Health();

  final Health _health;

  /// 書き込むデータ種別。歩行セッションはワークアウトとして記録する。
  static const List<HealthDataType> _types = [HealthDataType.WORKOUT];
  static const List<HealthDataAccess> _permissions = [HealthDataAccess.WRITE];

  bool _configured = false;

  Future<void> _ensureConfigured() async {
    if (_configured) return;
    await _health.configure();
    _configured = true;
  }

  @override
  Future<bool> requestAuthorization() async {
    await _ensureConfigured();
    return _health.requestAuthorization(_types, permissions: _permissions);
  }

  @override
  Future<bool> writeWalkingWorkout(WalkingWorkout workout) async {
    if (!await requestAuthorization()) return false;
    return _health.writeWorkoutData(
      activityType: HealthWorkoutActivityType.WALKING,
      start: workout.start,
      end: workout.end,
      totalEnergyBurned: workout.kcal,
      totalEnergyBurnedUnit: HealthDataUnit.KILOCALORIE,
      // health パッケージは距離をメートル（整数）で受ける。
      totalDistance: (workout.km * 1000).round(),
      totalDistanceUnit: HealthDataUnit.METER,
    );
  }
}
