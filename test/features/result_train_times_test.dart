import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FixedRouteService implements RouteService {
  _FixedRouteService(this.result);
  final RoutePlan result;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
  }) async => result;
}

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(theme: ArukuTheme.light(), home: const ResultScreen()),
);

ProviderContainer _containerFor(RoutePlan plan) {
  final container = ProviderContainer(
    overrides: [
      routeServiceProvider.overrideWithValue(_FixedRouteService(plan)),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

RoutePlan _planWith(RouteSegment train) => RoutePlan(
  from: '上野',
  to: '赤坂見附',
  totalKm: 0.6,
  totalMin: 20,
  budgetMin: 90,
  kcal: 55,
  walkKm: 0.6,
  walkRatio: 0.3,
  segments: [
    const RouteSegment(
      type: SegmentType.walk,
      fromName: '上野',
      toName: '上野駅',
      km: 0.6,
      minutes: 8,
      kcal: 55,
    ),
    train,
  ],
  timelineNodes: const [
    TimelineNode(time: '21:46', place: '上野', sub: '出発'),
    TimelineNode(time: '21:54', place: '上野駅', sub: '徒歩へ'),
    TimelineNode(time: '22:13', place: '赤坂見附駅', sub: '到着 · 制限内 ✓'),
  ],
);

void main() {
  testWidgets('発着時刻を持つ電車区間は「発・着」時刻を表示する', (tester) async {
    final plan = _planWith(
      RouteSegment(
        type: SegmentType.train,
        fromName: '上野駅',
        toName: '赤坂見附駅',
        minutes: 19,
        line: '東京メトロ銀座線',
        fare: 210,
        depTime: DateTime(2026, 6, 19, 21, 54),
        arrTime: DateTime(2026, 6, 19, 22, 13),
      ),
    );
    final container = _containerFor(plan);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.text('21:54発 → 22:13着'), findsOneWidget);
    // 駅名・運賃の行は従来どおり残る。
    expect(find.textContaining('上野駅 → 赤坂見附駅'), findsOneWidget);
  });

  testWidgets('発着時刻が無い電車区間は時刻行を出さない', (tester) async {
    final plan = _planWith(
      const RouteSegment(
        type: SegmentType.train,
        fromName: '上野駅',
        toName: '赤坂見附駅',
        minutes: 19,
        line: '東京メトロ銀座線',
        fare: 210,
        // depTime / arrTime は未設定。
      ),
    );
    final container = _containerFor(plan);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // 「HH:MM発 → HH:MM着」形式の時刻行が出ないこと。
    expect(find.textContaining('発 → '), findsNothing);
    expect(find.textContaining('上野駅 → 赤坂見附駅'), findsOneWidget);
  });
}
