import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
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
    CancellationToken? cancellation,
  }) async => result;
}

/// fare 未設定の train セグメントを含むプラン（ハイブリッド経路を模す）。
const _nullFarePlan = RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: 5,
  totalMin: 40,
  budgetMin: 90,
  kcal: 150,
  walkKm: 3,
  walkRatio: 0.6,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: 'A',
      toName: '新橋駅',
      km: 2.0,
      minutes: 25,
      kcal: 100,
    ),
    RouteSegment(
      type: SegmentType.train,
      fromName: '新橋駅',
      toName: '東京駅',
      minutes: 8,
      line: 'JR山手線',
      stops: 1,
      // fare は未設定（null）。
    ),
  ],
  timelineNodes: [
    TimelineNode(time: '9:00', place: 'A', sub: '出発'),
    TimelineNode(time: '9:25', place: '新橋駅', sub: 'JR山手線'),
    TimelineNode(time: '9:33', place: '東京駅', sub: '到着'),
  ],
);

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const ResultScreen(),
  ),
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

void main() {
  testWidgets('fare 未設定の train セグメントは「¥null」を表示しない', (tester) async {
    final container = _containerFor(_nullFarePlan);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // null がそのまま文字列化されて出ていないこと。
    expect(find.textContaining('¥null'), findsNothing);
    expect(find.textContaining('null'), findsNothing);
    // 区間名（出発駅→到着駅）は出ること。
    expect(find.textContaining('新橋駅 → 東京駅'), findsOneWidget);
  });
}
