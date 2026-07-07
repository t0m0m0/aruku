import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_plan_builder.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('buildRoutePlan timeline', () {
    test('乗車駅ノードは徒歩到着ではなく電車の発車時刻を表示する', () {
      // 9:00 出発 → 徒歩5分で駅着 9:05 → 電車は 9:12 発・9:30 着。
      // 乗車駅ノードは早着して待つぶんを含め「電車の発車時刻 9:12」を表示する（駅着 9:05
      // ではない）。到着は累積分(9:23)ではなく 9:30。
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
        '9:12',
        '9:30',
      ]);
      // 乗車駅は発車時刻＋路線名（駅着 9:05 → 9:12 発。待ちは表示しない）。
      expect(plan.timelineNodes[1].sub, '○○線');
      expect(plan.timelineNodes.last.sub, '到着 · 制限内 ✓');
      expect(plan.totalMin, 30);
    });

    test('直結乗換は乗換駅を「着」「発」の2行に分ける', () {
      // 徒歩5分(9:05着) → 電車1 9:10発/9:25着 → （間に徒歩なし）→ 電車2 9:40発/10:00着。
      // 乗換駅 S2 は電車1の到着 9:25（着・無表示・カード無し）と電車2の発車 9:40（発・
      // 15分待ち）の2行に分ける。
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
        '9:10',
        '9:25',
        '9:40',
        '10:00',
      ]);
      expect(plan.totalMin, 60);
      // S1 乗車駅は電車1の発（9:05着→9:10発。待ちは表示しない）。
      expect(plan.timelineNodes[1].sub, '1号線');
      // 乗換駅 S2 の「着」行は無表示＆カードを挟まない。
      expect(plan.timelineNodes[2].place, 'S2');
      expect(plan.timelineNodes[2].sub, '');
      expect(plan.timelineNodes[2].cardBelow, isFalse);
      // 乗換駅 S2 の「発」行は電車2の発（9:25着→9:40発。待ちは表示しない）。
      expect(plan.timelineNodes[3].place, 'S2');
      expect(plan.timelineNodes[3].sub, '2号線');
    });

    test('0km・0分の徒歩レッグは除外し直結乗換にする（#225 保険）', () {
      // 同駅乗換で挿入され得る 0km・0分の徒歩レッグは segments から落とし、
      // timelineNodes と 1:1 対応を保ったまま直結乗換として描く。
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
        const RouteSegment(
          type: SegmentType.walk,
          fromName: 'S2',
          toName: 'S2',
          minutes: 0,
          km: 0,
          kcal: 0,
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
        from: 'S1',
        to: 'S3',
        segments: segments,
        departure: const TimeValue(h: 9, m: 10),
        budgetMin: 90,
        departureAt: DateTime(2026, 5, 22, 9, 10),
      );

      // 0値 walk は segments から除外され電車2本のみ。
      expect(plan.segments.map((s) => s.type), [
        SegmentType.train,
        SegmentType.train,
      ]);
      // ノード列は [S1出発, S2着(カード無し), S2発, S3到着]。
      // S2 は「着（カード無し）」＋「発」の直結乗換2行になる。
      expect(plan.timelineNodes[1].place, 'S2');
      expect(plan.timelineNodes[1].cardBelow, isFalse);
      expect(plan.timelineNodes[2].place, 'S2');
      expect(plan.timelineNodes[2].sub, '2号線');
    });

    test('全区間が0値徒歩の退化入力でも出発・到着ノードは残す（#225）', () {
      // from≈to の 0km・0分ルート等。フィルタ後 segments が空でも到着ノードを欠落
      // させない。
      final plan = buildRoutePlan(
        from: 'A',
        to: 'A',
        segments: const [
          RouteSegment(
            type: SegmentType.walk,
            fromName: 'A',
            toName: 'A',
            minutes: 0,
            km: 0,
            kcal: 0,
          ),
        ],
        departure: const TimeValue(h: 9, m: 0),
        budgetMin: 30,
      );

      expect(plan.segments, isEmpty);
      expect(plan.timelineNodes.map((n) => n.place), ['A', 'A']);
      expect(plan.timelineNodes.first.sub, '出発');
      expect(plan.timelineNodes.last.sub, '到着 · 制限内 ✓');
      expect(plan.totalMin, 0);
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

      // 乗車駅（発）ノードは待ち 0 なので路線名のみ。
      expect(plan.timelineNodes[1].sub, '○○線');
      // 降車駅は到着時刻＋「徒歩へ」。
      expect(plan.timelineNodes[2].place, 'B駅');
      expect(plan.timelineNodes[2].sub, '徒歩へ');
    });

    test('着時刻が欠落(arr=null)でも発車時刻で待ちを算出する（NAVITIME発車時刻を採用）', () {
      // 9:00発・徒歩5分で 9:05 駅着 → 発車 9:12（NAVITIME 値）まで7分待ち。着時刻が
      // 無くても発車時刻があれば「7分待ち」と NAVITIME の実時刻で表示する（乗車時間は
      // 着時刻欠落のため距離概算18分）。電車の後に徒歩を置き電車ノードの sub を確認する。
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
          // arrTime は null。
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

      // 駅着 9:05 → 7分待ち → 9:12 発 → 乗車18分で 9:30 着 → 徒歩3分で 9:33 着。
      // 待ちを使わない旧挙動なら総 26 分(=5+18+3)。発車時刻採用で 33 分になる。
      // 乗車駅（発）は 9:12（待ち非表示）、降車駅（着）は arr 欠落のため累積 9:30。
      expect(plan.timelineNodes[1].time, '9:12');
      expect(plan.timelineNodes[1].sub, '○○線');
      expect(plan.timelineNodes[2].time, '9:30');
      expect(plan.timelineNodes[2].sub, '徒歩へ');
      expect(plan.totalMin, 33);
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
      // 乗り遅れは待ち無し扱いなので乗車駅（発）は「○分待ち」を前置きしない。
      expect(plan.timelineNodes[1].sub, '○○線');
    });

    test('時刻表区間が前段の概算（フォールバック）に続いても発車時刻で待ちを算出する', () {
      // 1本目は発着時刻なし＝所要分で概算（9:00+20=9:20着）。2本目は時刻表
      // 9:35発・10:00着。直結乗換なので乗換駅 B は「着 9:20」「発 9:35（15分待ち）」の2行。
      // 末尾に徒歩2分を足し、2号線の発ノードの sub を検証できるようにする。
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
        '9:35',
        '10:00',
        '10:02',
      ]);
      expect(plan.totalMin, 62);
      // 乗換駅 B の「着」行(index1)は無表示、「発」行(index2)は概算到着 9:20 →
      // 発車 9:35（待ち非表示。先頭に徒歩が無いぶん test B より index が 1 つ前）。
      expect(plan.timelineNodes[1].sub, '');
      expect(plan.timelineNodes[1].cardBelow, isFalse);
      expect(plan.timelineNodes[2].sub, '2号線');
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

    test('降車駅の時刻が欠落(arr=null)でも発車時刻を過ぎて駅着なら乗り遅れ（実データ）', () {
      // 実データ再現: 自由が丘 発=04:30 はあるが 代官山 着=null。徒歩を延ばして駅着が
      // 発車後（4:31着）になれば、降車時刻が無くても発車時刻だけで乗り遅れと判定する。
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: '自由が丘',
          minutes: 33, // 03:58発 → 04:31着（発車04:30の1分後）
        ),
        RouteSegment(
          type: SegmentType.train,
          fromName: '自由が丘',
          toName: '代官山',
          minutes: 11,
          line: '東急東横線急行',
          depTime: DateTime(2026, 6, 15, 4, 30),
          // arrTime は NAVITIME が返さない（null）。
        ),
      ];

      final missed = firstMissedTrain(segments, DateTime(2026, 6, 15, 3, 58));
      expect(missed, isNotNull);
      expect(missed!.index, 1);
      expect(missed.cumBefore, 33);
    });

    test('発車時刻があり着時刻が欠落でも発車前に駅着なら乗り遅れなし（null）', () {
      // 03:58発・徒歩20分で 04:18 駅着 → 発車04:30 まで待てる（乗り遅れではない）。
      final segments = [
        const RouteSegment(
          type: SegmentType.walk,
          fromName: '出発地',
          toName: '自由が丘',
          minutes: 20,
        ),
        RouteSegment(
          type: SegmentType.train,
          fromName: '自由が丘',
          toName: '代官山',
          minutes: 11,
          line: '東急東横線急行',
          depTime: DateTime(2026, 6, 15, 4, 30),
        ),
      ];

      expect(firstMissedTrain(segments, DateTime(2026, 6, 15, 3, 58)), isNull);
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
