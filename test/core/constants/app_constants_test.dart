import 'package:aruku/core/constants/app_constants.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AppConstants', () {
    test('週間目標は 10.0km で集約されている', () {
      expect(AppConstants.weeklyGoalKm, 10.0);
    });

    test('週間目標プリセットは昇順で既定値を含む', () {
      const presets = AppConstants.weeklyGoalPresetsKm;
      expect(presets, isNotEmpty);
      expect(presets, contains(AppConstants.weeklyGoalKm));
      final sorted = [...presets]..sort();
      expect(presets, sorted);
      expect(presets.every((v) => v > 0), isTrue);
    });
  });
}
