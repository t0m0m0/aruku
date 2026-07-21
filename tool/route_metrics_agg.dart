// 端末ログの `[route-metrics]` 行（RouteSearchMetrics.toLogLine・#309）を集計し、
// collapse/board-search の発火率と上流往復本数・所要時間の分布を出す CLI（#310 判断材料）。
//
// #310（乗車駅探索のマトリクスバッチ化）は collapse/board-search の発火率が低ければ
// 費用対効果が限定的。発火率は端末の debugPrint にしか出ない（サーバへ送っていない）ため、
// 実機ログをこの集計器へ流して発火率・削減余地を数値で確認してから着手可否を決める。
//
// 使い方:
//   flutter run/logcat の出力を保存して:  dart run tool/route_metrics_agg.dart device.log
//   パイプで直接:                          flutter run | dart run tool/route_metrics_agg.dart
//
// PII は含めない（元ログにも座標・駅名は出ない・#268）。集計はメタデータのみ。
import 'dart:convert';
import 'dart:io';

/// `[route-metrics]` 1行を parse した1検索分の定量指標。フィールドは
/// [RouteSearchMetrics.toLogLine] の key と一対一に対応する。
class RouteMetricSample {
  const RouteMetricSample({
    required this.collapse,
    required this.boardSearch,
    required this.http,
    required this.guidanceCalls,
    required this.walkCalls,
    required this.matrixCalls,
    required this.guidanceMs,
    required this.boardSearchMs,
    required this.finalizeMs,
    required this.totalMs,
  });

  final bool collapse;
  final bool boardSearch;
  final int http;
  final int guidanceCalls;
  final int walkCalls;
  final int matrixCalls;
  final int guidanceMs;
  final int boardSearchMs;
  final int finalizeMs;
  final int totalMs;
}

/// 行内の `key=value`（整数値のみ）を全て拾う。行頭一致にしないのは、実機ログが
/// `flutter:`（iOS）や `I/flutter(12345):`（Android logcat）等の前置きを付けるため。
final RegExp _kvPattern = RegExp(r'(\w+)=(-?\d+)');
const String _kMarker = '[route-metrics]';

/// [line] を [RouteMetricSample] に parse する。`[route-metrics]` マーカーが無い行
/// （定性ログ・無関係な出力）は null。マーカー以降の key=value を抽出するので、
/// ログ収集ツールの前置きが付いていても復元できる。
RouteMetricSample? parseRouteMetricsLine(String line) {
  final markerAt = line.indexOf(_kMarker);
  if (markerAt < 0) return null;
  final body = line.substring(markerAt + _kMarker.length);
  final fields = <String, int>{};
  for (final m in _kvPattern.allMatches(body)) {
    fields[m.group(1)!] = int.parse(m.group(2)!);
  }
  int at(String key) => fields[key] ?? 0;
  return RouteMetricSample(
    collapse: at('collapse') == 1,
    boardSearch: at('boardSearch') == 1,
    http: at('http'),
    guidanceCalls: at('guidanceCalls'),
    walkCalls: at('walkCalls'),
    matrixCalls: at('matrixCalls'),
    guidanceMs: at('guidanceMs'),
    boardSearchMs: at('boardSearchMs'),
    finalizeMs: at('finalizeMs'),
    totalMs: at('totalMs'),
  );
}

/// [lines] のうち `[route-metrics]` 行だけを [RouteMetricSample] にする。
List<RouteMetricSample> parseRouteMetricsLines(Iterable<String> lines) => [
  for (final l in lines) ?parseRouteMetricsLine(l),
];

/// 整数系列の要約統計。空系列は count=0・各値 null（表示側で `-` に落とす）。
class MetricStats {
  const MetricStats({
    required this.count,
    required this.min,
    required this.p50,
    required this.p90,
    required this.max,
    required this.mean,
  });

  final int count;
  final int? min;
  final int? p50;
  final int? p90;
  final int? max;
  final double? mean;
}

/// nearest-rank パーセンタイル（ISO・`ceil(p/100 * n)` の1-based順位・補間なし）。
/// 少数サンプルで補間すると存在しない中間値を作ってしまうため、実測値そのものを返す。
int _percentile(List<int> sorted, int p) {
  if (sorted.isEmpty) throw StateError('empty');
  final rank = (p / 100 * sorted.length).ceil().clamp(1, sorted.length);
  return sorted[rank - 1];
}

/// [values] の要約統計を計算する。
MetricStats statsOf(List<int> values) {
  if (values.isEmpty) {
    return const MetricStats(
      count: 0,
      min: null,
      p50: null,
      p90: null,
      max: null,
      mean: null,
    );
  }
  final sorted = [...values]..sort();
  final sum = sorted.fold<int>(0, (a, b) => a + b);
  return MetricStats(
    count: sorted.length,
    min: sorted.first,
    p50: _percentile(sorted, 50),
    p90: _percentile(sorted, 90),
    max: sorted.last,
    mean: sum / sorted.length,
  );
}

/// 全サンプルの集計結果。発火率と、全体／collapse サブセットの往復本数・所要分布を持つ。
class MetricsAggregation {
  const MetricsAggregation({
    required this.count,
    required this.collapseCount,
    required this.boardSearchCount,
    required this.http,
    required this.guidanceCalls,
    required this.walkCalls,
    required this.matrixCalls,
    required this.totalMs,
    required this.boardSearchMs,
    required this.collapseWalkCalls,
    required this.collapseMatrixCalls,
    required this.collapseBoardSearchMs,
  });

  final int count;
  final int collapseCount;
  final int boardSearchCount;

  final MetricStats http;
  final MetricStats guidanceCalls;
  final MetricStats walkCalls;
  final MetricStats matrixCalls;
  final MetricStats totalMs;
  final MetricStats boardSearchMs;

  /// collapse=1 サブセットの統計（#310 が直接動かすレバー）。
  final MetricStats collapseWalkCalls;
  final MetricStats collapseMatrixCalls;
  final MetricStats collapseBoardSearchMs;

  double get collapseRate => count == 0 ? 0.0 : collapseCount / count;
  double get boardSearchRate => count == 0 ? 0.0 : boardSearchCount / count;
}

/// [samples] を集計する。全体分布に加え、collapse=1 サブセットの walkCalls/matrixCalls/
/// boardSearchMs を切り出す——非崩壊は board-search が走らず walkCalls=0 なので、混ぜると
/// #310 の削減余地が薄まって見えるため。
MetricsAggregation aggregate(List<RouteMetricSample> samples) {
  final collapsed = [
    for (final s in samples)
      if (s.collapse) s,
  ];
  return MetricsAggregation(
    count: samples.length,
    collapseCount: collapsed.length,
    boardSearchCount: samples.where((s) => s.boardSearch).length,
    http: statsOf([for (final s in samples) s.http]),
    guidanceCalls: statsOf([for (final s in samples) s.guidanceCalls]),
    walkCalls: statsOf([for (final s in samples) s.walkCalls]),
    matrixCalls: statsOf([for (final s in samples) s.matrixCalls]),
    totalMs: statsOf([for (final s in samples) s.totalMs]),
    boardSearchMs: statsOf([for (final s in samples) s.boardSearchMs]),
    collapseWalkCalls: statsOf([for (final s in collapsed) s.walkCalls]),
    collapseMatrixCalls: statsOf([for (final s in collapsed) s.matrixCalls]),
    collapseBoardSearchMs: statsOf([
      for (final s in collapsed) s.boardSearchMs,
    ]),
  );
}

String _pct(double rate) => '${(rate * 100).toStringAsFixed(1)}%';

String _statLine(String label, MetricStats s) {
  if (s.count == 0) return '  $label: (0件)';
  final mean = s.mean!.toStringAsFixed(1);
  return '  $label: min=${s.min} p50=${s.p50} p90=${s.p90} '
      'max=${s.max} mean=$mean';
}

/// 集計結果を人が読めるレポートに整形する。#310 判断の要点（発火率・collapse 時の
/// walkCalls＝削減余地）を上段に置く。
String formatAggregation(MetricsAggregation a) {
  final b = StringBuffer()
    ..writeln('=== route-metrics 集計 (#309→#310 判断材料) ===')
    ..writeln('samples=${a.count}')
    ..writeln(
      'collapse発火: ${a.collapseCount}/${a.count} (${_pct(a.collapseRate)})',
    )
    ..writeln(
      'boardSearch起動: ${a.boardSearchCount}/${a.count} '
      '(${_pct(a.boardSearchRate)})',
    )
    ..writeln('--- 全体分布 ---')
    ..writeln(_statLine('http往復', a.http))
    ..writeln(_statLine('guidanceCalls', a.guidanceCalls))
    ..writeln(_statLine('walkCalls', a.walkCalls))
    ..writeln(_statLine('matrixCalls', a.matrixCalls))
    ..writeln(_statLine('totalMs', a.totalMs))
    ..writeln('--- collapse=1 サブセット（#310 が動かすレバー） ---')
    ..writeln(_statLine('walkCalls(崩壊時)', a.collapseWalkCalls))
    ..writeln(_statLine('matrixCalls(崩壊時)', a.collapseMatrixCalls))
    ..writeln(_statLine('boardSearchMs', a.collapseBoardSearchMs));
  return b.toString();
}

Future<void> main(List<String> args) async {
  final lines = <String>[];
  if (args.isEmpty) {
    // 引数なしは stdin（`flutter run | dart run tool/route_metrics_agg.dart`）。
    // マルチバイトがチャンク境界で割れないよう utf8.decoder＋LineSplitter で行に割る。
    lines.addAll(
      await stdin
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .toList(),
    );
  } else {
    for (final path in args) {
      lines.addAll(await File(path).readAsLines());
    }
  }
  final samples = parseRouteMetricsLines(lines);
  stdout.writeln(formatAggregation(aggregate(samples)));
}
