import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
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

/// onProgress を任意段階まで呼んだあと completer で待機するフェイク。
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
    CancellationToken? cancellation,
  }) async {
    for (final p in phases) {
      onProgress?.call(p);
    }
    await completer.future;
    return _plan;
  }
}

void main() {
  group('AppNotifier.startSearch の進捗連動', () {
    test('loading 遷移直後は routePhase が routing', () async {
      final service = _GatedRouteService([RoutePhase.routing]);
      final container = ProviderContainer(
        overrides: [routeServiceProvider.overrideWithValue(service)],
      );
      addTearDown(container.dispose);

      final future = container.read(appStateProvider.notifier).startSearch();
      final state = container.read(appStateProvider);
      expect(state.screen, Screen.loading);
      expect(state.routePhase, RoutePhase.routing);

      service.completer.complete();
      await future;
    });

    test('onProgress の段階が state.routePhase に反映される', () async {
      final service = _GatedRouteService([
        RoutePhase.routing,
        RoutePhase.walkability,
      ]);
      final container = ProviderContainer(
        overrides: [routeServiceProvider.overrideWithValue(service)],
      );
      addTearDown(container.dispose);

      final future = container.read(appStateProvider.notifier).startSearch();
      expect(
        container.read(appStateProvider).routePhase,
        RoutePhase.walkability,
      );

      service.completer.complete();
      await future;
      expect(container.read(appStateProvider).screen, Screen.result);
    });
  });
}
