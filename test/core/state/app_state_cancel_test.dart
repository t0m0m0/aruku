import 'dart:async';

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

/// 進捗を任意段階まで通知したあと completer が完了するまで待機するフェイク。
/// キャンセルが「進行中のリクエスト」を跨ぐ状況を再現するために使う。
class _GatedRouteService implements RouteService {
  final completer = Completer<void>();
  void Function(RoutePhase)? lastOnProgress;

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
    lastOnProgress = onProgress;
    onProgress?.call(RoutePhase.routing);
    await completer.future;
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
  group('AppNotifier.cancelSearch', () {
    test('キャンセルすると即座にホームへ戻り routePhase がクリアされる', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      expect(container.read(appStateProvider).screen, Screen.loading);

      notifier.cancelSearch();
      final state = container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.routePhase, isNull);
      expect(state.routeErrorKind, isNull);

      // 後片付け（in-flight を完了させても state は home のまま）。
      service.completer.complete();
      await future;
      expect(container.read(appStateProvider).screen, Screen.home);
    });

    test('キャンセル後に plan が完了しても結果を反映しない', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      notifier.cancelSearch();
      service.completer.complete();
      await future;

      final state = container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.route, isNull);
    });

    test('キャンセル後は onProgress が来ても routePhase を書き換えない', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final future = notifier.startSearch();
      notifier.cancelSearch();
      // in-flight の plan がまだ進捗通知を送ってくる状況を再現する。
      service.lastOnProgress?.call(RoutePhase.building);

      expect(container.read(appStateProvider).routePhase, isNull);

      service.completer.complete();
      await future;
    });

    test('キャンセル後に再検索するとその結果は正しく反映される', () async {
      final service = _GatedRouteService();
      final container = _containerWith(service);
      final notifier = container.read(appStateProvider.notifier);

      final first = notifier.startSearch();
      notifier.cancelSearch();
      service.completer.complete();
      await first;
      expect(container.read(appStateProvider).screen, Screen.home);

      // 2 回目の検索は別世代なので通常どおり result へ遷移する。
      final service2 = _ImmediateRouteService();
      final container2 = _containerWith(service2);
      await container2.read(appStateProvider.notifier).startSearch();
      expect(container2.read(appStateProvider).screen, Screen.result);
    });
  });
}

/// 即座に成功するフェイク（回帰確認用）。
class _ImmediateRouteService implements RouteService {
  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
  }) async => _plan;
}
