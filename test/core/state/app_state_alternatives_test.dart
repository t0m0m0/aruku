import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/route_plan_fixtures.dart';

/// 位置ストリームを外部制御できる LocationService（リルート発火の再現用）。
class _StreamLocationService implements LocationService {
  _StreamLocationService(this._controller);
  final StreamController<GeoPoint> _controller;

  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => _controller.stream;
}

/// 1 回目の plan() は [first] を、2 回目以降は [reroute] を返す。
class _RerouteRouteService implements RouteService {
  _RerouteRouteService({required this.first, required this.reroute});
  final RoutePlan first;
  final RoutePlan reroute;
  int calls = 0;

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
    calls++;
    return calls == 1 ? first : reroute;
  }
}

/// 可変の現在時刻。`now` を [nowProvider] へ渡し、`value` を書き換えて時間を進める。
class _Clock {
  _Clock(this.value);
  DateTime value;
  DateTime now() => value;
}

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

const _alt1 = RoutePlan(
  from: '新宿三丁目',
  to: '渋谷ヒカリエ',
  totalKm: 5.0,
  totalMin: 65,
  budgetMin: 90,
  kcal: 240,
  walkKm: 4.0,
  walkRatio: 0.9,
  segments: [],
  timelineNodes: [],
);

const _alt2 = RoutePlan(
  from: '新宿三丁目',
  to: '渋谷ヒカリエ',
  totalKm: 3.0,
  totalMin: 55,
  budgetMin: 90,
  kcal: 150,
  walkKm: 2.0,
  walkRatio: 0.6,
  segments: [],
  timelineNodes: [],
);

final _winnerWithAlternatives = RoutePlan(
  from: sampleRoutePlan.from,
  to: sampleRoutePlan.to,
  totalKm: sampleRoutePlan.totalKm,
  totalMin: sampleRoutePlan.totalMin,
  budgetMin: sampleRoutePlan.budgetMin,
  kcal: sampleRoutePlan.kcal,
  walkKm: sampleRoutePlan.walkKm,
  walkRatio: sampleRoutePlan.walkRatio,
  segments: sampleRoutePlan.segments,
  timelineNodes: sampleRoutePlan.timelineNodes,
  alternatives: const [_alt1, _alt2],
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
  group('AppState.routeAlternatives', () {
    test('初期状態は空リスト', () {
      final container = _containerFor(sampleRoutePlan);
      expect(container.read(appStateProvider).routeAlternatives, isEmpty);
    });

    test('startSearch 成功時に plan.alternatives が state へ載る', () async {
      final container = _containerFor(_winnerWithAlternatives);
      await container.read(appStateProvider.notifier).startSearch();

      final state = container.read(appStateProvider);
      expect(state.route, _winnerWithAlternatives);
      expect(state.routeAlternatives, [_alt1, _alt2]);
    });

    test('alternatives が空のプランは空リストのまま', () async {
      final container = _containerFor(sampleRoutePlan);
      await container.read(appStateProvider.notifier).startSearch();

      expect(container.read(appStateProvider).routeAlternatives, isEmpty);
    });
  });

  group('AppNotifier.selectAlternative', () {
    test('確定経路と代替案を入れ替える', () async {
      final container = _containerFor(_winnerWithAlternatives);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();

      notifier.selectAlternative(0);

      final state = container.read(appStateProvider);
      expect(state.route, _alt1);
      expect(state.routeAlternatives, [_winnerWithAlternatives, _alt2]);
    });

    test('再度同じ index を選ぶと元の経路に戻る（往復可能）', () async {
      final container = _containerFor(_winnerWithAlternatives);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();

      notifier.selectAlternative(0);
      notifier.selectAlternative(0);

      final state = container.read(appStateProvider);
      expect(state.route, _winnerWithAlternatives);
      expect(state.routeAlternatives, [_alt1, _alt2]);
    });

    test('2番目の候補を選んでも他の候補の並びは保たれる', () async {
      final container = _containerFor(_winnerWithAlternatives);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();

      notifier.selectAlternative(1);

      final state = container.read(appStateProvider);
      expect(state.route, _alt2);
      expect(state.routeAlternatives, [_alt1, _winnerWithAlternatives]);
    });

    test('範囲外 index は無視される', () async {
      final container = _containerFor(_winnerWithAlternatives);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      final before = container.read(appStateProvider);

      notifier.selectAlternative(-1);
      notifier.selectAlternative(99);

      final after = container.read(appStateProvider);
      expect(after.route, before.route);
      expect(after.routeAlternatives, before.routeAlternatives);
    });

    test('route 未確定（検索前）では何もしない', () {
      final container = _containerFor(_winnerWithAlternatives);
      final notifier = container.read(appStateProvider.notifier);

      notifier.selectAlternative(0);

      final state = container.read(appStateProvider);
      expect(state.route, isNull);
      expect(state.routeAlternatives, isEmpty);
    });

    test('選択操作では画面遷移しない', () async {
      final container = _containerFor(_winnerWithAlternatives);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      expect(container.read(appStateProvider).screen, Screen.result);

      notifier.selectAlternative(0);

      expect(container.read(appStateProvider).screen, Screen.result);
    });
  });

  group('routeAlternatives のクリア', () {
    test('自動リルート成功後は stale な代替案を空にする', () async {
      const offRoute = GeoPoint(35.69, 139.85);
      final controller = StreamController<GeoPoint>.broadcast();
      final route = _RerouteRouteService(
        first: _winnerWithAlternatives,
        reroute: sampleRoutePlan,
      );
      final container = ProviderContainer(
        overrides: [
          locationServiceProvider.overrideWithValue(
            _StreamLocationService(controller),
          ),
          routeServiceProvider.overrideWithValue(route),
        ],
      );
      addTearDown(controller.close);
      addTearDown(container.dispose);

      final notifier = container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      expect(container.read(appStateProvider).routeAlternatives, isNotEmpty);

      notifier.go(Screen.nav);
      for (var i = 0; i < 3; i++) {
        controller.add(offRoute);
        await Future<void>.delayed(Duration.zero);
      }
      await Future<void>.delayed(Duration.zero);

      final state = container.read(appStateProvider);
      expect(state.route, sampleRoutePlan);
      expect(state.routeAlternatives, isEmpty);
    });

    test('isNow 経路が失効すると代替案も空にする', () async {
      final clock = _Clock(DateTime(2026, 7, 13, 9, 25));
      final container = ProviderContainer(
        overrides: [
          nowProvider.overrideWithValue(clock.now),
          routeServiceProvider.overrideWithValue(
            _FixedRouteService(_winnerWithAlternatives),
          ),
          onboardingCompletedProvider.overrideWithValue(true),
        ],
      );
      addTearDown(container.dispose);

      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      expect(container.read(appStateProvider).routeAlternatives, isNotEmpty);

      clock.value = DateTime(2026, 7, 13, 14, 40);
      await notifier.onAppResumed();

      final state = container.read(appStateProvider);
      expect(state.route, isNull);
      expect(state.routeAlternatives, isEmpty);
    });
  });
}
