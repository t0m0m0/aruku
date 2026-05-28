import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/services/route_plan_builder.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ActivitySnapshot.fromSteps', () {
    test('0 歩なら距離・kcal ともに 0', () {
      final snap = ActivitySnapshot.fromSteps(0);
      expect(snap.steps, 0);
      expect(snap.km, 0.0);
      expect(snap.kcal, 0);
    });

    test('歩数から歩幅 0.75m で距離を算出する', () {
      // 1000 歩 × 0.75m = 750m = 0.75km
      final snap = ActivitySnapshot.fromSteps(1000);
      expect(snap.steps, 1000);
      expect(snap.km, closeTo(0.75, 1e-9));
    });

    test('距離 × kcalPerKm を四捨五入して kcal を算出する', () {
      // 0.75km × 57 = 42.75 → 43
      final snap = ActivitySnapshot.fromSteps(1000);
      expect(snap.kcal, (0.75 * kcalPerKm).round());
      expect(snap.kcal, 43);
    });

    test('同じ歩数なら等価', () {
      expect(ActivitySnapshot.fromSteps(500), ActivitySnapshot.fromSteps(500));
    });
  });
}
