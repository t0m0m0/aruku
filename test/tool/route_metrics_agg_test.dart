import 'package:aruku/core/services/route_diagnostics.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../tool/route_metrics_agg.dart';

void main() {
  group('parseRouteMetricsLine', () {
    test('toLogLine() の出力を往復パースして全フィールドを復元する', () {
      // 集計器はログ整形の正本 toLogLine() と契約の両端。実際の出力を parse し戻して
      // 一致することで、フォーマット drift（片側だけの変更）を CI で検出する。
      final m = RouteSearchMetrics()
        ..collapseFired = true
        ..boardSearchActivated = true
        ..guidanceCalls = 4
        ..walkCalls = 6
        ..matrixCalls = 2
        ..guidanceMs = 900
        ..boardSearchMs = 3200
        ..finalizeMs = 120
        ..totalMs = 5000;

      final sample = parseRouteMetricsLine('[route-metrics] ${m.toLogLine()}');

      expect(sample, isNotNull);
      expect(sample!.collapse, isTrue);
      expect(sample.boardSearch, isTrue);
      expect(sample.http, m.httpRoundTrips);
      expect(sample.guidanceCalls, 4);
      expect(sample.walkCalls, 6);
      expect(sample.matrixCalls, 2);
      expect(sample.guidanceMs, 900);
      expect(sample.boardSearchMs, 3200);
      expect(sample.finalizeMs, 120);
      expect(sample.totalMs, 5000);
    });

    test('flutter run / logcat の前置きが付いた行からもマーカー以降を抽出する', () {
      const androidLine =
          'I/flutter (12345): [route-metrics] collapse=1 boardSearch=1 '
          'http=5 guidanceCalls=3 walkCalls=0 matrixCalls=2 '
          'guidanceMs=800 boardSearchMs=2100 finalizeMs=90 totalMs=4200';

      final sample = parseRouteMetricsLine(androidLine);

      expect(sample, isNotNull);
      expect(sample!.collapse, isTrue);
      expect(sample.matrixCalls, 2);
      expect(sample.totalMs, 4200);
    });

    test('[route-metrics] マーカーの無い行は null（定性ログや無関係行を混ぜても安全）', () {
      expect(parseRouteMetricsLine('[route] chosen: walk=3m arr=40m'), isNull);
      expect(parseRouteMetricsLine('flutter: Restarted application'), isNull);
      expect(parseRouteMetricsLine(''), isNull);
    });
  });

  group('aggregate', () {
    List<RouteMetricSample> samplesOf(List<String> lines) => [
      for (final l in lines) ?parseRouteMetricsLine(l),
    ];

    test('発火率＝collapse/boardSearch の 1 件数 ÷ 総件数', () {
      final agg = aggregate(
        samplesOf(const [
          '[route-metrics] collapse=0 boardSearch=0 http=3 guidanceCalls=1 '
              'walkCalls=0 matrixCalls=2 guidanceMs=1 boardSearchMs=0 '
              'finalizeMs=1 totalMs=1',
          '[route-metrics] collapse=1 boardSearch=1 http=9 guidanceCalls=5 '
              'walkCalls=3 matrixCalls=1 guidanceMs=1 boardSearchMs=1 '
              'finalizeMs=1 totalMs=1',
          '[route-metrics] collapse=1 boardSearch=0 http=3 guidanceCalls=1 '
              'walkCalls=0 matrixCalls=2 guidanceMs=1 boardSearchMs=0 '
              'finalizeMs=1 totalMs=1',
          '[route-metrics] collapse=0 boardSearch=0 http=3 guidanceCalls=1 '
              'walkCalls=0 matrixCalls=2 guidanceMs=1 boardSearchMs=0 '
              'finalizeMs=1 totalMs=1',
        ]),
      );

      expect(agg.count, 4);
      expect(agg.collapseCount, 2);
      expect(agg.boardSearchCount, 1);
      expect(agg.collapseRate, 0.5);
      expect(agg.boardSearchRate, 0.25);
    });

    test('collapse サブセットの walkCalls 統計＝#310 で削減できる往復本数の的', () {
      // collapse=1 のときだけ board-search が走り walkCalls が積み上がる。集計器は
      // collapse サブセットの walkCalls を切り出し、#310 の費用対効果を数値で出す。
      final agg = aggregate(
        samplesOf(const [
          // 非崩壊は walkCalls=0。サブセットに混ぜてはいけない。
          '[route-metrics] collapse=0 boardSearch=0 http=3 guidanceCalls=1 '
              'walkCalls=0 matrixCalls=2 guidanceMs=1 boardSearchMs=0 '
              'finalizeMs=1 totalMs=1',
          '[route-metrics] collapse=1 boardSearch=1 http=9 guidanceCalls=5 '
              'walkCalls=6 matrixCalls=1 guidanceMs=1 boardSearchMs=1 '
              'finalizeMs=1 totalMs=1',
          '[route-metrics] collapse=1 boardSearch=1 http=9 guidanceCalls=5 '
              'walkCalls=2 matrixCalls=1 guidanceMs=1 boardSearchMs=1 '
              'finalizeMs=1 totalMs=1',
        ]),
      );

      expect(agg.collapseWalkCalls.count, 2);
      expect(agg.collapseWalkCalls.min, 2);
      expect(agg.collapseWalkCalls.max, 6);
      expect(agg.collapseWalkCalls.mean, 4.0);
    });

    test('空入力でも壊れずゼロ件として集計する', () {
      final agg = aggregate(const []);
      expect(agg.count, 0);
      expect(agg.collapseRate, 0.0);
      expect(agg.boardSearchRate, 0.0);
    });
  });

  group('statsOf percentiles', () {
    test('p50/p90 は nearest-rank（ソート後の順位）で返す', () {
      final s = statsOf(const [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(s.count, 10);
      expect(s.min, 1);
      expect(s.max, 10);
      expect(s.p50, 5);
      expect(s.p90, 9);
    });

    test('空リストは count=0 の空統計', () {
      final s = statsOf(const []);
      expect(s.count, 0);
      expect(s.min, isNull);
      expect(s.p90, isNull);
    });
  });

  group('formatAggregation', () {
    test('総件数・発火率・往復本数を人が読める行に整形する', () {
      final agg = aggregate([
        parseRouteMetricsLine(
          '[route-metrics] collapse=1 boardSearch=1 http=9 guidanceCalls=5 '
          'walkCalls=3 matrixCalls=1 guidanceMs=1 boardSearchMs=1 '
          'finalizeMs=1 totalMs=1',
        )!,
      ]);
      final report = formatAggregation(agg);
      expect(report, contains('samples=1'));
      expect(report, contains('collapse'));
      expect(report, contains('boardSearch'));
      expect(report, contains('walkCalls'));
    });
  });
}
