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

    test('予定列車の発車後に駅着（乗り遅れ）なら待ち無しで乗車時間を足す', () {
      // 徒歩20分で駅着 9:20 だが、予定列車は 9:12 発・9:30 着（乗車18分）。
      // 次列車の時刻は持たないため、待ち無しで実到着 9:20 + 乗車18分 = 9:38。
      // 末尾に徒歩3分を足し、電車ノード（非最終）の sub を検証できるようにする。
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: 'A駅',
          minutes: 20,
        ),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 18,
          line: '○○線',
          depTime: DateTime(2026, 5, 22, 9, 12),
          arrTime: DateTime(2026, 5, 22, 9, 30),
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

      expect(plan.timelineNodes.map((n) => n.time).toList(), [
        '9:00',
        '9:20',
        '9:38',
        '9:41',
      ]);
      expect(plan.totalMin, 41);
      // 乗り遅れは待ち無し扱いなので「○分待ち」を前置きしない。
      expect(plan.timelineNodes[2].sub, '○○線');
    });

    test('時刻表区間が前段の概算（フォールバック）に続いても発車時刻で待ちを算出する', () {
      // 1本目は発着時刻なし＝所要分で概算（9:00+20=9:20着）。2本目は時刻表
      // 9:35発・10:00着。乗換待ちは発車時刻基準で 9:35-9:20=15分。
      // 末尾に徒歩2分を足し、2号線ノード（非最終）の sub を検証できるようにする。
      final segments = [
        const RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 20,
          line: '1号線',
        ),
        RouteSegment(
          type: SegmentType.train,
          fromName: 'B駅',
          toName: 'C駅',
          minutes: 25,
          line: '2号線',
          depTime: DateTime(2026, 5, 22, 9, 35),
          arrTime: DateTime(2026, 5, 22, 10, 0),
        ),
        const RouteSegment(
          type: SegmentType.walk,
          fromName: 'C駅',
          toName: '目的地',
          minutes: 2,
        ),
      ];

      final plan = buildRoutePlan(
        from: 'A駅',
        to: '目的地',
        segments: segments,
        departure: const TimeValue(h: 9, m: 0),
        budgetMin: 90,
        departureAt: DateTime(2026, 5, 22, 9, 0),
      );

      expect(plan.timelineNodes.map((n) => n.time).toList(), [
        '9:00',
        '9:20',
        '10:00',
        '10:02',
      ]);
      expect(plan.totalMin, 62);
      // 2号線ノードは概算到着 9:20 → 発車 9:35 の 15分待ちを前置きする。
      expect(plan.timelineNodes[2].sub, '15分待ち · 2号線');
    });
  });

  group('firstMissedTrain', () {
    test('予定列車の発車後に駅着なら乗り遅れ区間を返す', () {
      // 徒歩20分で駅着(累積20分)。予定列車は 9:12 発（発車相対12分）→ 20 > 12 で乗り遅れ。
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: 'A駅',
          minutes: 20,
        ),
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

      final missed = firstMissedTrain(segments, DateTime(2026, 5, 22, 9, 0));

      expect(missed, isNotNull);
      expect(missed!.index, 1);
      expect(missed.cumBefore, 20); // 駅着までの実累積分（再照会の start_time 算出に使う）
    });

    test('発車前に駅着なら乗り遅れなし（null）', () {
      // 徒歩5分で駅着(累積5分) < 発車相対12分 → 間に合う。
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
          minutes: 18,
          line: '○○線',
          depTime: DateTime(2026, 5, 22, 9, 12),
          arrTime: DateTime(2026, 5, 22, 9, 30),
        ),
      ];

      expect(firstMissedTrain(segments, DateTime(2026, 5, 22, 9, 0)), isNull);
    });

    test('駅着と発車が同時刻（累積==発車相対）は乗り遅れにしない', () {
      // 累積12分 == 発車相対12分 → ちょうど乗車（待ち0）。_advance と同基準で乗り遅れ扱いしない。
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: 'A駅',
          minutes: 12,
        ),
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

      expect(firstMissedTrain(segments, DateTime(2026, 5, 22, 9, 0)), isNull);
    });

    test('発着時刻が無い電車区間は乗り遅れ判定の対象外（null）', () {
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: 'A駅',
          minutes: 30,
        ),
        const RouteSegment(
          type: SegmentType.train,
          fromName: 'A駅',
          toName: 'B駅',
          minutes: 18,
          line: '○○線',
        ),
      ];

      expect(firstMissedTrain(segments, DateTime(2026, 5, 22, 9, 0)), isNull);
    });

    test('departureAt 起点で先行区間の待ちを吸収した累積で判定する', () {
      // 1本目: 9:10発・9:25着（待ち含む）。2本目: 駅着9:25 > 発車相対(9:20=20分)で乗り遅れ。
      final segments = [
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
          minutes: 10,
          line: '2号線',
          depTime: DateTime(2026, 5, 22, 9, 20), // 9:25着より前に発車＝乗り遅れ
          arrTime: DateTime(2026, 5, 22, 9, 30),
        ),
      ];

      final missed = firstMissedTrain(segments, DateTime(2026, 5, 22, 9, 0));

      expect(missed, isNotNull);
      expect(missed!.index, 1);
      expect(missed.cumBefore, 25); // S2 着までの累積（9:25）
    });
  });

  group('hasUntimedNightTrain', () {
    RouteSegment walk(int minutes) => RouteSegment(
      type: SegmentType.walk,
      fromName: 'a',
      toName: 'b',
      minutes: minutes,
      km: 1,
    );

    RouteSegment untimedTrain(int minutes) => RouteSegment(
      type: SegmentType.train,
      fromName: '自由が丘',
      toName: '代官山',
      minutes: minutes,
      line: '東急東横線急行',
    );

    test('深夜帯に駅着して untimed電車へ乗る区間があれば true', () {
      // 1:51発・徒歩86分で 3:17 に駅着 → untimed電車。深夜帯で乗車可否を確証できない。
      final segments = [walk(86), untimedTrain(11), walk(60)];
      expect(
        hasUntimedNightTrain(segments, DateTime(2026, 6, 14, 1, 51)),
        isTrue,
      );
    });

    test('昼間に駅着する untimed電車は false（#67 の挙動を変えない）', () {
      // 9:00発・徒歩20分で 9:20 に駅着 → 日中なので対象外。
      final segments = [walk(20), untimedTrain(7), walk(10)];
      expect(
        hasUntimedNightTrain(segments, DateTime(2026, 6, 14, 9, 0)),
        isFalse,
      );
    });

    test('深夜でも時刻表付き電車は false（untimed のみが対象）', () {
      final segments = [
        walk(86),
        RouteSegment(
          type: SegmentType.train,
          fromName: '自由が丘',
          toName: '代官山',
          minutes: 11,
          line: '東急東横線急行',
          depTime: DateTime(2026, 6, 14, 3, 20),
          arrTime: DateTime(2026, 6, 14, 3, 31),
        ),
      ];
      expect(
        hasUntimedNightTrain(segments, DateTime(2026, 6, 14, 1, 51)),
        isFalse,
      );
    });

    test('電車を含まない全徒歩は false', () {
      expect(
        hasUntimedNightTrain([walk(180)], DateTime(2026, 6, 14, 1, 51)),
        isFalse,
      );
    });
  });

  group('budgetMinutes', () {
    test('同日内は到着−出発の差をそのまま返す', () {
      expect(
        budgetMinutes(
          const TimeValue(h: 9, m: 0),
          const TimeValue(h: 10, m: 30),
        ),
        90,
      );
    });

    test('到着が翌日(dateOffset:1)なら日跨ぎ分を加算する', () {
      // 23:55 出発 → 翌 0:55 着。dateOffset で +1440 され予算は 60 分。
      expect(
        budgetMinutes(
          const TimeValue(h: 23, m: 55),
          const TimeValue(h: 0, m: 55, dateOffset: 1),
        ),
        60,
      );
    });

    test('出発が isNow なら dateOffset を無視して当日扱いにする', () {
      // 出発 isNow は当日固定（offset 無視）、到着 dateOffset:1 のみ繰り上がる。
      expect(
        budgetMinutes(
          const TimeValue(h: 23, m: 55, isNow: true, dateOffset: 3),
          const TimeValue(h: 0, m: 55, dateOffset: 1),
        ),
        60,
      );
    });
  });
}
