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

RoutePlan _planWith({required int budgetMin, required int totalMin}) =>
    RoutePlan(
      from: 'A',
      to: 'B',
      totalKm: 4,
      totalMin: totalMin,
      budgetMin: budgetMin,
      kcal: 100,
      walkKm: 2,
      walkRatio: 0.5,
      segments: const [],
      timelineNodes: const [TimelineNode(time: '9:00', place: 'A', sub: '出発')],
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

Future<void> _pumpResult(WidgetTester tester, RoutePlan plan) async {
  final container = _containerFor(plan);
  await container.read(appStateProvider.notifier).startSearch();
  await tester.pumpWidget(_wrap(container));
  await tester.pump();
}

void main() {
  testWidgets('余裕が正なら「N分 余裕」と表示し「超過」を含まない', (tester) async {
    await _pumpResult(tester, _planWith(budgetMin: 90, totalMin: 78));

    expect(find.textContaining('12分 余裕'), findsOneWidget);
    expect(find.textContaining('超過'), findsNothing);
  });

  testWidgets('余裕が0なら境界は余裕側で「0分 余裕」と表示する', (tester) async {
    await _pumpResult(tester, _planWith(budgetMin: 60, totalMin: 60));

    expect(find.textContaining('0分 余裕'), findsOneWidget);
    expect(find.textContaining('0分 超過'), findsNothing);
  });

  testWidgets('制限超過なら絶対値で「N分 超過」と表示し「余裕」を含まない', (tester) async {
    await _pumpResult(tester, _planWith(budgetMin: 60, totalMin: 100));

    expect(find.textContaining('40分 超過'), findsOneWidget);
    expect(find.textContaining('余裕'), findsNothing);
    // 「-40分」のような負値の直接表示が残っていないこと。
    expect(find.textContaining('-40'), findsNothing);
  });
}
