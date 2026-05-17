import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
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

/// 1 回目は throw、2 回目以降は成功する。
class _FlakyRouteService implements RouteService {
  int calls = 0;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    void Function(RoutePhase)? onProgress,
  }) async {
    calls++;
    if (calls == 1) throw const RouteException('NETWORK');
    return _plan;
  }
}

void main() {
  group('AppNotifier.startSearch エラーハンドリング', () {
    test('plan が throw したら loading で固まらず error 画面へ遷移する', () async {
      final container = ProviderContainer(
        overrides: [
          routeServiceProvider.overrideWithValue(_FlakyRouteService()),
        ],
      );
      addTearDown(container.dispose);

      await container.read(appStateProvider.notifier).startSearch();

      final state = container.read(appStateProvider);
      expect(state.screen, Screen.error);
      expect(state.routeError, isNotNull);
      expect(state.route, isNull);
    });

    test('error 後に再試行すると result へ遷移しエラーがクリアされる', () async {
      final container = ProviderContainer(
        overrides: [
          routeServiceProvider.overrideWithValue(_FlakyRouteService()),
        ],
      );
      addTearDown(container.dispose);

      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      expect(container.read(appStateProvider).screen, Screen.error);

      await notifier.startSearch();
      final state = container.read(appStateProvider);
      expect(state.screen, Screen.result);
      expect(state.route, same(_plan));
      expect(state.routeError, isNull);
    });
  });
}
