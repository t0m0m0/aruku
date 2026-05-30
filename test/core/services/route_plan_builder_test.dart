import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_plan_builder.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('buildRoutePlan timeline', () {
    test('乗車前の待ち時間を到着時刻に反映する', () {
      // 9:00 出発 → 徒歩5分で駅着 9:05 → 電車は 9:12 発・9:30 着。
      // 駅着(9:05)から発車(9:12)まで7分待つため、到着は累積分(9:23)ではなく 9:30。
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: 'A駅',
          minutes: 5,
          km: 0.4,
          kcal: 23,
        ),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 18,
          km: 6,
          line: '○○線',
          depTime: DateTime(2026, 5, 22, 9, 12),
          arrTime: DateTime(2026, 5, 22, 9, 30),
        ),
      ];

      final plan = buildRoutePlan(
        from: '出発地',
        to: 'B駅',
        segments: segments,
        departure: const TimeValue(h: 9, m: 0),
        budgetMin: 60,
        departureAt: DateTime(2026, 5, 22, 9, 0),
      );

      expect(plan.timelineNodes.map((n) => n.time).toList(), [
        '9:00',
        '9:05',
        '9:30',
      ]);
      expect(plan.totalMin, 30);
    });

    test('乗り換え待ち時間を到着時刻に反映する', () {
      // 徒歩5分(9:05着) → 電車1 9:10発/9:25着 → 乗換15分待ち → 電車2 9:40発/10:00着。
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: 'S1',
          minutes: 5,
        ),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'S1',
          toName: 'S2',
          minutes: 15,
          line: '1号線',
          depTime: DateTime(2026, 5, 22, 9, 10),
          arrTime: DateTime(2026, 5, 22, 9, 25),
        ),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'S2',
          toName: 'S3',
          minutes: 20,
          line: '2号線',
          depTime: DateTime(2026, 5, 22, 9, 40),
          arrTime: DateTime(2026, 5, 22, 10, 0),
        ),
      ];

      final plan = buildRoutePlan(
        from: '出発地',
        to: 'S3',
        segments: segments,
        departure: const TimeValue(h: 9, m: 0),
        budgetMin: 90,
        departureAt: DateTime(2026, 5, 22, 9, 0),
      );

      expect(plan.timelineNodes.map((n) => n.time).toList(), [
        '9:00',
        '9:05',
        '9:25',
        '10:00',
      ]);
      expect(plan.totalMin, 60);
      // 電車1ノードは乗車前の待ち（9:05着→9:10発=5分）を路線名に前置きする。
      expect(plan.timelineNodes[2].sub, '5分待ち · 1号線');
    });

    test('待ち時間が無い電車ノードは路線名のみ表示する', () {
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: 'A駅',
          minutes: 5,
        ),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 15,
          line: '○○線',
          // 9:05 着・9:05 発で待ち 0。
          depTime: DateTime(2026, 5, 22, 9, 5),
          arrTime: DateTime(2026, 5, 22, 9, 20),
        ),
        const RouteSegment(
          type: SegmentType.walk,
          fromName: 'B駅',
          toName: '目的地',
          minutes: 3,
        ),
      ];

      final plan = buildRoutePlan(
        from: '出発地',
        to: '目的地',
        segments: segments,
        departure: const TimeValue(h: 9, m: 0),
        budgetMin: 60,
        departureAt: DateTime(2026, 5, 22, 9, 0),
      );

      expect(plan.timelineNodes[2].sub, '○○線');
    });

    test('発着時刻が無い電車区間は累積所要分にフォールバックする', () {
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: 'A駅',
          minutes: 5,
        ),
        const RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 18,
          line: '○○線',
        ),
      ];

      final plan = buildRoutePlan(
        from: '出発地',
        to: 'B駅',
        segments: segments,
        departure: const TimeValue(h: 9, m: 0),
        budgetMin: 60,
        departureAt: DateTime(2026, 5, 22, 9, 0),
      );

      expect(plan.timelineNodes.map((n) => n.time).toList(), [
        '9:00',
        '9:05',
        '9:23',
      ]);
      expect(plan.totalMin, 23);
    });

    test('departureAt が無ければ絶対時刻を無視して累積所要分で算出する', () {
      final segments = [
        RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 18,
          line: '○○線',
          depTime: DateTime(2026, 5, 22, 9, 12),
          arrTime: DateTime(2026, 5, 22, 9, 30),
        ),
      ];

      final plan = buildRoutePlan(
        from: 'A駅',
        to: 'B駅',
        segments: segments,
        departure: const TimeValue(h: 9, m: 0),
        budgetMin: 60,
      );

      expect(plan.timelineNodes.last.time, '9:18');
      expect(plan.totalMin, 18);
    });
  });
}
