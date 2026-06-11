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

RoutePlan _planWith({required int totalMin, required int budgetMin}) =>
    RoutePlan(
      from: 'A',
      to: 'B',
      totalKm: 4,
      totalMin: totalMin,
      budgetMin: budgetMin,
      kcal: 120,
      walkKm: 4,
      walkRatio: 1,
      segments: const [
        RouteSegment(
          type: SegmentType.walk,
          fromName: 'A',
          toName: 'B',
          km: 4,
          minutes: 75,
          kcal: 120,
        ),
      ],
      timelineNodes: const [TimelineNode(time: '9:00', place: 'A', sub: '出発')],
    );

Future<void> _pump(WidgetTester tester, ProviderContainer container) async {
  await container.read(appStateProvider.notifier).startSearch();
  await tester.pumpWidget(_wrap(container));
  await tester.pump();
}

void main() {
  group('結果画面の所要時間表記', () {
    testWidgets('TOTAL は60分以上を n時m分 で表示する', (tester) async {
      final container = _containerFor(_planWith(totalMin: 100, budgetMin: 120));
      await _pump(tester, container);

      expect(find.text('1時 40分'), findsOneWidget);
    });

    testWidgets('TOTAL は60分未満を「分」のみで表示し 0時 を出さない', (tester) async {
      final container = _containerFor(_planWith(totalMin: 45, budgetMin: 60));
      await _pump(tester, container);

      expect(find.text('45分'), findsOneWidget);
      expect(find.textContaining('0時'), findsNothing);
    });

    testWidgets('区間の所要が60分以上なら n時m分 で表示する', (tester) async {
      final container = _containerFor(_planWith(totalMin: 75, budgetMin: 120));
      await _pump(tester, container);

      // 75分 ではなく 1時15分 に分解される。
      expect(find.text('75'), findsNothing);
      expect(find.text('時'), findsWidgets);
      expect(find.text('15'), findsWidgets);
    });
  });
}
