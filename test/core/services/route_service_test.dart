import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _fakePlan = RoutePlan(
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

class _FakeRouteService implements RouteService {
  int calls = 0;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required dynamic destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    dynamic origin,
  }) async {
    calls++;
    return _fakePlan;
  }
}

void main() {
  group('AppNotifier.startSearch + RouteService', () {
    test('RouteService 経由で plan を取得し state.route へ反映する', () async {
      final service = _FakeRouteService();
      final container = ProviderContainer(
        overrides: [routeServiceProvider.overrideWithValue(service)],
      );
      addTearDown(container.dispose);

      await container.read(appStateProvider.notifier).startSearch();

      final state = container.read(appStateProvider);
      expect(service.calls, 1);
      expect(state.screen, Screen.result);
      expect(state.route, same(_fakePlan));
    });

    test('startSearch 中は loading 画面を経由する', () async {
      final container = ProviderContainer(
        overrides: [
          routeServiceProvider.overrideWithValue(_FakeRouteService()),
        ],
      );
      addTearDown(container.dispose);

      final future = container.read(appStateProvider.notifier).startSearch();
      expect(container.read(appStateProvider).screen, Screen.loading);
      await future;
      expect(container.read(appStateProvider).screen, Screen.result);
    });
  });

  group('DummyRouteService', () {
    test('遅延 0 指定で妥当な RoutePlan を返す', () async {
      final service = DummyRouteService(latency: Duration.zero);
      final plan = await service.plan(
        destination: '渋谷ヒカリエ',
        destinationLatLng: null,
        departure: const TimeValue(h: 9, m: 32),
        arrival: const TimeValue(h: 10, m: 50),
      );

      expect(plan.segments, isNotEmpty);
      for (final seg in plan.segments) {
        expect(seg.polyline, isNotEmpty);
      }
      for (var i = 0; i < plan.segments.length - 1; i++) {
        expect(
          plan.segments[i].polyline.last,
          plan.segments[i + 1].polyline.first,
        );
      }
    });
  });
}
