import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_error.dart';
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

/// 1 回目は指定 status で throw、2 回目以降は成功する。
class _FlakyRouteService implements RouteService {
  _FlakyRouteService([this.status = 'HTTP 500']);
  final String status;
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
    if (calls == 1) throw RouteException(status);
    return _plan;
  }
}

ProviderContainer _containerWith(RouteService service) {
  final container = ProviderContainer(
    overrides: [routeServiceProvider.overrideWithValue(service)],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  group('AppNotifier.startSearch エラーハンドリング', () {
    test('plan が throw したら loading で固まらず error 画面へ遷移する', () async {
      final container = _containerWith(_FlakyRouteService());

      await container.read(appStateProvider.notifier).startSearch();

      final state = container.read(appStateProvider);
      expect(state.screen, Screen.error);
      expect(state.routeErrorKind, isNotNull);
      expect(state.route, isNull);
      expect(state.routePhase, isNull);
    });

    test('例外の status に応じて routeErrorKind が分類される', () async {
      Future<RouteErrorKind?> kindFor(String status) async {
        final container = _containerWith(_FlakyRouteService(status));
        await container.read(appStateProvider.notifier).startSearch();
        return container.read(appStateProvider).routeErrorKind;
      }

      expect(await kindFor('NO_ORIGIN'), RouteErrorKind.noLocation);
      expect(await kindFor('ZERO_RESULTS'), RouteErrorKind.noResults);
      expect(await kindFor('HTTP 503'), RouteErrorKind.network);
      expect(await kindFor('REQUEST_DENIED'), RouteErrorKind.unknown);
    });

    test('error 後に再試行すると result へ遷移しエラーがクリアされる', () async {
      final container = _containerWith(_FlakyRouteService());

      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      expect(container.read(appStateProvider).screen, Screen.error);

      await notifier.startSearch();
      final state = container.read(appStateProvider);
      expect(state.screen, Screen.result);
      expect(state.route, same(_plan));
      expect(state.routeErrorKind, isNull);
    });
  });
}
