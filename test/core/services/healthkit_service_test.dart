import 'package:aruku/core/services/health_service.dart';
import 'package:aruku/core/services/healthkit_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:health/health.dart';

/// メソッドチャネルに触れず呼び出しを記録する [Health] の差し替え。
class _FakeHealth extends Health {
  _FakeHealth({this.grant = true});

  final bool grant;

  bool configured = false;
  List<HealthDataType>? authTypes;
  List<HealthDataAccess>? authPermissions;
  int writeCount = 0;
  HealthWorkoutActivityType? activityType;
  int? kcal;
  int? meters;

  @override
  Future<void> configure() async {
    configured = true;
  }

  @override
  Future<bool> requestAuthorization(
    List<HealthDataType> types, {
    List<HealthDataAccess>? permissions,
  }) async {
    authTypes = types;
    authPermissions = permissions;
    return grant;
  }

  @override
  Future<bool> writeWorkoutData({
    required HealthWorkoutActivityType activityType,
    required DateTime start,
    required DateTime end,
    int? totalEnergyBurned,
    HealthDataUnit totalEnergyBurnedUnit = HealthDataUnit.KILOCALORIE,
    int? totalDistance,
    HealthDataUnit totalDistanceUnit = HealthDataUnit.METER,
    String? title,
    RecordingMethod recordingMethod = RecordingMethod.automatic,
  }) async {
    writeCount++;
    this.activityType = activityType;
    kcal = totalEnergyBurned;
    meters = totalDistance;
    return true;
  }
}

void main() {
  final workout = WalkingWorkout(
    start: DateTime(2026, 7, 7, 10),
    end: DateTime(2026, 7, 7, 10, 30),
    steps: 1200,
    km: 0.9,
    kcal: 45,
  );

  test('requestAuthorization は WORKOUT に WRITE 権限を要求する', () async {
    final fake = _FakeHealth(grant: true);
    final service = HealthKitService(health: fake);

    expect(await service.requestAuthorization(), isTrue);
    expect(fake.authTypes, [HealthDataType.WORKOUT]);
    expect(fake.authPermissions, [HealthDataAccess.WRITE]);
  });

  test('writeWalkingWorkout は WALKING・kcal・km→m でワークアウトを書き込む', () async {
    final fake = _FakeHealth(grant: true);
    final service = HealthKitService(health: fake);

    expect(await service.writeWalkingWorkout(workout), isTrue);
    expect(fake.writeCount, 1);
    expect(fake.activityType, HealthWorkoutActivityType.WALKING);
    expect(fake.kcal, 45);
    // 0.9km → 900m。
    expect(fake.meters, 900);
  });

  test('権限が拒否されたら書き込まず false を返す', () async {
    final fake = _FakeHealth(grant: false);
    final service = HealthKitService(health: fake);

    expect(await service.writeWalkingWorkout(workout), isFalse);
    expect(fake.writeCount, 0);
  });
}
