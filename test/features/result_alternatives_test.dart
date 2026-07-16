import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:aruku/shared/widgets/aruku_button.dart';
import 'package:aruku/shared/widgets/aruku_map.dart';
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
    CancellationToken? cancellation,
  }) async => result;
}

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
  testWidgets('地図を表示する', (tester) async {
    final container = _containerFor(sampleRoutePlan);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.byType(ArukuMap), findsOneWidget);
  });

  testWidgets('代替案があれば候補セクションと各候補の要約を表示する', (tester) async {
    final container = _containerFor(sampleRoutePlanWithAlternatives);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.text('他の候補'), findsOneWidget);
    // 1件目: 徒歩18+38=56分・到着 10:40（arrTime 由来）・乗換0回。
    expect(find.textContaining('徒歩56分'), findsOneWidget);
    expect(find.textContaining('到着 10:40'), findsOneWidget);
    expect(find.textContaining('乗換0回'), findsOneWidget);
    // 2件目: 徒歩10+22=32分・到着 10:27（timelineNodes 由来）・乗換1回。
    expect(find.textContaining('徒歩32分'), findsOneWidget);
    expect(find.textContaining('到着 10:27'), findsOneWidget);
    expect(find.textContaining('乗換1回'), findsOneWidget);
  });

  testWidgets('代替案が0件なら候補セクションを出さない', (tester) async {
    final container = _containerFor(sampleRoutePlan);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(find.text('他の候補'), findsNothing);
  });

  testWidgets('候補カードをタップすると表示内容が切り替わる', (tester) async {
    final container = _containerFor(sampleRoutePlanWithAlternatives);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    // 切替前は勝者（sampleRoutePlan 由来）の所要時間が表示されている。
    expect(find.textContaining('徒歩56分'), findsOneWidget);

    await tester.ensureVisible(find.textContaining('徒歩56分'));
    await tester.tap(find.textContaining('徒歩56分'), warnIfMissed: false);
    await tester.pump();

    // 切替後は元の勝者が代替案リストへ回り、選んだ候補の内訳が表示される。
    expect(container.read(appStateProvider).route, sampleAlternativeArrTime);
    expect(find.textContaining('徒歩32分'), findsOneWidget);
  });

  testWidgets('候補セクション表示後も「このルートで歩く」CTAは画面内に残る', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final container = _containerFor(sampleRoutePlanWithAlternatives);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    final ctaTop = tester.getTopLeft(find.byType(ArukuButton)).dy;
    final screenHeight = tester.view.physicalSize.height / 3.0;
    expect(ctaTop, lessThan(screenHeight));
  });

  testWidgets('候補カードはタップ可能なセマンティクスを持つ', (tester) async {
    final handle = tester.ensureSemantics();
    final container = _containerFor(sampleRoutePlanWithAlternatives);
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    expect(
      tester.getSemantics(find.textContaining('徒歩56分').first),
      containsSemantics(isButton: true, hasTapAction: true),
    );
    handle.dispose();
  });
}
