import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/loading/loading_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _plan = RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: 1,
  totalMin: 1,
  budgetMin: 1,
  kcal: 1,
  walkKm: 1,
  walkRatio: 1,
  segments: [],
  timelineNodes: [],
);

class _GatedRouteService implements RouteService {
  _GatedRouteService(this.phases);

  final List<RoutePhase> phases;
  final completer = Completer<void>();

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
  }) async {
    for (final p in phases) {
      onProgress?.call(p);
    }
    await completer.future;
    return _plan;
  }
}

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(theme: ArukuTheme.light(), home: const LoadingScreen()),
);

void main() {
  testWidgets('目的地と時間制限を文言に動的反映する', (tester) async {
    final service = _GatedRouteService([RoutePhase.routing]);
    final container = ProviderContainer(
      overrides: [routeServiceProvider.overrideWithValue(service)],
    );
    addTearDown(container.dispose);

    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('渋谷ヒカリエ');
    unawaited(notifier.startSearch());

    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    final budget = TimeValue.formatBudgetJp(
      container.read(appStateProvider).budgetMinutes,
    );
    expect(find.textContaining('渋谷ヒカリエ'), findsOneWidget);
    expect(find.textContaining(budget), findsOneWidget);

    service.completer.complete();
  });

  /// バーの塗り率（[FractionallySizedBox.widthFactor]）を読む。
  /// Tween を終端まで進めるため、無限アニメと衝突しない固定時間で pump する。
  double fillFraction(WidgetTester tester) {
    final box = tester.widget<FractionallySizedBox>(
      find.byKey(const ValueKey('loading-progress-fill')),
    );
    return box.widthFactor ?? 0;
  }

  testWidgets('routing 段階ではバーが 1/3 まで伸びる', (tester) async {
    final service = _GatedRouteService([RoutePhase.routing]);
    final container = ProviderContainer(
      overrides: [routeServiceProvider.overrideWithValue(service)],
    );
    addTearDown(container.dispose);

    unawaited(container.read(appStateProvider.notifier).startSearch());
    await tester.pumpWidget(_wrap(container));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));

    expect(fillFraction(tester), closeTo(1 / 3, 0.001));

    service.completer.complete();
  });

  testWidgets('walkability 段階ではバーが 2/3 まで伸びる', (tester) async {
    final service = _GatedRouteService([
      RoutePhase.routing,
      RoutePhase.walkability,
    ]);
    final container = ProviderContainer(
      overrides: [routeServiceProvider.overrideWithValue(service)],
    );
    addTearDown(container.dispose);

    unawaited(container.read(appStateProvider.notifier).startSearch());
    await tester.pumpWidget(_wrap(container));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));

    expect(fillFraction(tester), closeTo(2 / 3, 0.001));

    service.completer.complete();
  });

  testWidgets('building 段階ではバーが 100% まで伸びる', (tester) async {
    final service = _GatedRouteService([
      RoutePhase.routing,
      RoutePhase.walkability,
      RoutePhase.building,
    ]);
    final container = ProviderContainer(
      overrides: [routeServiceProvider.overrideWithValue(service)],
    );
    addTearDown(container.dispose);

    unawaited(container.read(appStateProvider.notifier).startSearch());
    await tester.pumpWidget(_wrap(container));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 700));

    expect(fillFraction(tester), closeTo(1.0, 0.001));

    service.completer.complete();
  });
}
