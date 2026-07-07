import 'package:aruku/core/services/health_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('WalkingWorkout', () {
    final start = DateTime(2026, 7, 7, 10);
    final end = DateTime(2026, 7, 7, 10, 30);

    test('値が等しければ == で等価', () {
      expect(
        WalkingWorkout(start: start, end: end, steps: 1200, km: 0.9, kcal: 45),
        WalkingWorkout(start: start, end: end, steps: 1200, km: 0.9, kcal: 45),
      );
    });

    test('歩数が違えば == で非等価', () {
      expect(
        WalkingWorkout(start: start, end: end, steps: 1200, km: 0.9, kcal: 45),
        isNot(
          WalkingWorkout(start: start, end: end, steps: 999, km: 0.9, kcal: 45),
        ),
      );
    });
  });

  group('NoopHealthService', () {
    test('requestAuthorization は false（連携先なし）', () async {
      const service = NoopHealthService();
      expect(await service.requestAuthorization(), isFalse);
    });

    test('writeWalkingWorkout は何もせず false を返す', () async {
      const service = NoopHealthService();
      final result = await service.writeWalkingWorkout(
        WalkingWorkout(
          start: DateTime(2026, 7, 7, 10),
          end: DateTime(2026, 7, 7, 10, 30),
          steps: 1200,
          km: 0.9,
          kcal: 45,
        ),
      );
      expect(result, isFalse);
    });
  });
}
