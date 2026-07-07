import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/route_plan_fixtures.dart';

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

const _overBudgetPlan = RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: 8,
  totalMin: 100,
  budgetMin: 60,
  kcal: 200,
  walkKm: 4,
  walkRatio: 0.5,
  segments: [],
  timelineNodes: [TimelineNode(time: '9:00', place: 'A', sub: '出発')],
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
  testWidgets('予算超過プランは超過バナーと条件変更導線を出す', (tester) async {
    final container = _containerFor(_overBudgetPlan);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.textContaining('超過'), findsOneWidget);
    // ①の修正後、バナーが出る＝予算内に間に合う経路が無く best-effort（最短）を
    // 表示している状態。「見つかりませんでした」と検索失敗のように示さず、最短の
    // 経路を表示中であることを誠実に伝える（不具合C）。
    expect(find.textContaining('見つかりませんでした'), findsNothing);
    expect(find.textContaining('最短の経路を表示'), findsOneWidget);
    expect(find.text('条件を変更'), findsOneWidget);

    await tester.tap(find.text('条件を変更'));
    await tester.pump();
    expect(container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('予算内プランは超過バナーを出さない', (tester) async {
    final container = _containerFor(sampleRoutePlan);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.textContaining('超過'), findsNothing);
  });
}
