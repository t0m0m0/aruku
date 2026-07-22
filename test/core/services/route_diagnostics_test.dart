import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart';
import 'package:aruku/core/services/route_diagnostics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

RouteSegment _walk(int minutes, {String from = '', String to = ''}) =>
    RouteSegment(
      type: SegmentType.walk,
      fromName: from,
      toName: to,
      minutes: minutes,
    );

RouteSegment _train(
  int minutes, {
  String from = '',
  String to = '',
  String? line,
}) => RouteSegment(
  type: SegmentType.train,
  fromName: from,
  toName: to,
  minutes: minutes,
  line: line,
  // depTime を持たせないことで maxBoardingWait/firstMissedTransit の対象外にし、
  // 整形テストを時刻計算に依存させない（時刻付き電車の挙動は選定側テストが担保）。
  polyline: const [GeoPoint(35.0, 139.0), GeoPoint(35.1, 139.1)],
);

void main() {
  const diag = RouteDiagnostics();

  group('segSummary', () {
    test('徒歩区間は walk{分}m 形式', () {
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_walk(12)]);
      expect(diag.segSummary(c), 'walk12m');
    });

    test('電車区間は路線名付き {line}_train{分}m、区間は + 連結', () {
      final c = RouteCandidate(
        from: 'A',
        to: 'B',
        segments: [
          _walk(12),
          _train(33, line: '蒲12'),
          _walk(3),
        ],
      );
      expect(diag.segSummary(c), 'walk12m+蒲12_train33m+walk3m');
    });

    test('路線名が無い電車区間は train へフォールバック', () {
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_train(20)]);
      expect(diag.segSummary(c), 'train_train20m');
    });
  });

  group('candLine', () {
    test('徒歩のみ候補は walk/arr/slack/within/maxWait/missed/構成を1行に詰める', () {
      final departureAt = DateTime(2026, 6, 27, 9, 0);
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_walk(40)]);
      expect(
        diag.candLine(c, 60, departureAt),
        'walk=40m arr=40m slack=20m within=true maxWait=0m '
        'missed=false [walk40m]',
      );
    });

    test('予算超過は within=false・slack が負になる', () {
      final departureAt = DateTime(2026, 6, 27, 9, 0);
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_walk(80)]);
      expect(
        diag.candLine(c, 60, departureAt),
        'walk=80m arr=80m slack=-20m within=false maxWait=0m '
        'missed=false [walk80m]',
      );
    });
  });

  group('RouteSearchMetrics.toLogLine', () {
    test('collapse/board-search/本数/フェーズ時間を安定した key=value 行にする', () {
      final m = RouteSearchMetrics()
        ..collapseFired = true
        ..boardSearchActivated = true
        ..guidanceCalls = 3
        ..guidanceDupCalls = 1
        ..walkCalls = 10
        ..matrixCalls = 2
        ..guidanceMs = 1200
        ..hybridMs = 500
        ..enrichMs = 2600
        ..boardSearchMs = 3400
        ..alternativesMs = 800
        ..finalizeMs = 300
        ..totalMs = 9000;
      expect(
        m.toLogLine(),
        'collapse=1 boardSearch=1 http=15 '
        'guidanceCalls=3 walkCalls=10 matrixCalls=2 '
        'guidanceDupCalls=1 '
        'guidanceMs=1200 hybridMs=500 enrichMs=2600 boardSearchMs=3400 '
        'alternativesMs=800 finalizeMs=300 totalMs=9000',
      );
    });

    test('bool は 0/1・http は本数合計として集計可能', () {
      final m = RouteSearchMetrics()
        ..guidanceCalls = 1
        ..walkCalls = 4;
      expect(m.httpRoundTrips, 5);
      expect(
        m.toLogLine(),
        'collapse=0 boardSearch=0 http=5 '
        'guidanceCalls=1 walkCalls=4 matrixCalls=0 '
        'guidanceDupCalls=0 '
        'guidanceMs=0 hybridMs=0 enrichMs=0 boardSearchMs=0 '
        'alternativesMs=0 finalizeMs=0 totalMs=0',
      );
    });
  });

  group('logMetrics のゲート（#309 レビュー指摘: profile でも出す）', () {
    List<String?> capture(void Function() body) {
      final lines = <String?>[];
      final original = debugPrint;
      debugPrint = (message, {int? wrapWidth}) => lines.add(message);
      try {
        body();
      } finally {
        debugPrint = original;
      }
      return lines;
    }

    test('定性ログ verbose=false でも metricsEnabled=true なら指標行を出す', () {
      // 実機フィールド計測は多く profile ビルド（verbose=false）。定量指標が定性ログの
      // debug 限定フラグに縛られず出ることを固定する（縛られると profile で発火率が出ない）。
      const diag = RouteDiagnostics(verbose: false, metricsEnabled: true);
      final lines = capture(() => diag.logMetrics(RouteSearchMetrics()));
      expect(lines, hasLength(1));
      expect(lines.single, startsWith('[route-metrics] collapse=0'));
    });

    test('metricsEnabled=false（release 相当）では何も出さない', () {
      const diag = RouteDiagnostics(metricsEnabled: false);
      final lines = capture(() => diag.logMetrics(RouteSearchMetrics()));
      expect(lines, isEmpty);
    });
  });

  group('boardingStationOf', () {
    test('最初の電車区間の乗車駅名を返す', () {
      final c = RouteCandidate(
        from: 'A',
        to: 'B',
        segments: [
          _walk(5),
          _train(20, from: '蒲田', to: '品川', line: 'JK'),
          _walk(3),
        ],
      );
      expect(diag.boardingStationOf(c), '蒲田');
    });

    test('電車が無ければ ?', () {
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_walk(30)]);
      expect(diag.boardingStationOf(c), '?');
    });

    test('乗車駅名が空なら ?', () {
      final c = RouteCandidate(from: 'A', to: 'B', segments: [_train(20)]);
      expect(diag.boardingStationOf(c), '?');
    });
  });
}
