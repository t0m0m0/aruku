import 'package:aruku/core/constants/app_constants.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AppConstants', () {
    test('週間目標は 10.0km で集約されている', () {
      expect(AppConstants.weeklyGoalKm, 10.0);
    });
  });
}
