import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/route_plan_fixtures.dart';

class _StreamLocationService implements LocationService {
  _StreamLocationService(this._controller);
  final StreamController<GeoPoint> _controller;

  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => _controller.stream;
}

/// 1 回目の plan() は [first] を、2 回目以降は [reroute] を返す。
/// [failReroute] が true なら 2 回目で例外を投げる。
class _FakeRouteService implements RouteService {
  _FakeRouteService({
    required this.first,
    required this.reroute,
    this.failReroute = false,
  });

  final RoutePlan first;
  final RoutePlan reroute;
  final bool failReroute;
  int calls = 0;
  final List<GeoPoint?> origins = [];

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
    calls++;
    origins.add(origin);
    if (calls == 1) return first;
    if (failReroute) throw const RouteException('fail');
    return reroute;
  }
}

/// 再検索後に返す、初期ルートとは別のルート。
const _reroutePlan = RoutePlan(
  from: '現在地',
  to: 'REROUTED',
  totalKm: 1.0,
  totalMin: 12,
  budgetMin: 30,
  kcal: 50,
  walkKm: 1.0,
  walkRatio: 1.0,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: '現在地',
      toName: 'REROUTED',
      minutes: 12,
      km: 1.0,
      kcal: 50,
      polyline: [GeoPoint(35.69, 139.85), GeoPoint(35.68, 139.84)],
    ),
  ],
  timelineNodes: [],
);

void main() {
  // 経路上の点（segment1 の頂点）と、経路から大きく外れた点。
  const onRoute = GeoPoint(35.6790, 139.7035);
  const offRoute = GeoPoint(35.69, 139.85);

  Future<void> tick() => Future<void>.delayed(Duration.zero);

  ({
    ProviderContainer container,
    _FakeRouteService route,
    StreamController<GeoPoint> pos,
  })
  setup({bool failReroute = false}) {
    final controller = StreamController<GeoPoint>.broadcast();
    final route = _FakeRouteService(
      first: sampleRoutePlan,
      reroute: _reroutePlan,
      failReroute: failReroute,
    );
    final container = ProviderContainer(
      overrides: [
        locationServiceProvider.overrideWithValue(
          _StreamLocationService(controller),
        ),
        routeServiceProvider.overrideWithValue(route),
      ],
    );
    return (container: container, route: route, pos: controller);
  }

  group('AppNotifier オフルート自動再検索', () {
    test('逸脱が継続すると現在地を起点に 1 回だけ再検索する', () async {
      final s = setup();
      addTearDown(s.pos.close);
      addTearDown(s.container.dispose);

      final notifier = s.container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      expect(s.route.calls, 1);
      expect(s.container.read(appStateProvider).route, sampleRoutePlan);

      notifier.go(Screen.nav);
      for (var i = 0; i < 3; i++) {
        s.pos.add(offRoute);
        await tick();
      }
      await tick();

      expect(s.route.calls, 2);
      expect(s.route.origins.last, offRoute);
      expect(s.container.read(appStateProvider).route, _reroutePlan);
      expect(s.container.read(appStateProvider).isRerouting, isFalse);
    });

    test('経路上を進んでいる間は再検索しない', () async {
      final s = setup();
      addTearDown(s.pos.close);
      addTearDown(s.container.dispose);

      final notifier = s.container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      notifier.go(Screen.nav);

      for (var i = 0; i < 5; i++) {
        s.pos.add(onRoute);
        await tick();
      }

      expect(s.route.calls, 1);
      expect(s.container.read(appStateProvider).route, sampleRoutePlan);
    });

    test('単発の逸脱（GPS ブレ）では再検索しない', () async {
      final s = setup();
      addTearDown(s.pos.close);
      addTearDown(s.container.dispose);

      final notifier = s.container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      notifier.go(Screen.nav);

      // 逸脱→復帰→逸脱…と単発が続いても継続閾値に達しない。
      s.pos.add(offRoute);
      await tick();
      s.pos.add(onRoute);
      await tick();
      s.pos.add(offRoute);
      await tick();

      expect(s.route.calls, 1);
    });

    test('再検索に失敗しても旧ルートを保持する', () async {
      final s = setup(failReroute: true);
      addTearDown(s.pos.close);
      addTearDown(s.container.dispose);

      final notifier = s.container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      notifier.go(Screen.nav);

      for (var i = 0; i < 3; i++) {
        s.pos.add(offRoute);
        await tick();
      }
      await tick();

      expect(s.route.calls, 2);
      expect(s.container.read(appStateProvider).route, sampleRoutePlan);
      expect(s.container.read(appStateProvider).isRerouting, isFalse);
    });

    test('再検索に失敗すると rerouteFailed が true になる', () async {
      final s = setup(failReroute: true);
      addTearDown(s.pos.close);
      addTearDown(s.container.dispose);

      final notifier = s.container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      notifier.go(Screen.nav);

      for (var i = 0; i < 3; i++) {
        s.pos.add(offRoute);
        await tick();
      }
      await tick();

      expect(s.container.read(appStateProvider).rerouteFailed, isTrue);
    });

    test('再検索に成功すると rerouteFailed が false に戻る', () async {
      final s = setup();
      addTearDown(s.pos.close);
      addTearDown(s.container.dispose);

      final notifier = s.container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      notifier.go(Screen.nav);

      for (var i = 0; i < 3; i++) {
        s.pos.add(offRoute);
        await tick();
      }
      await tick();

      expect(s.container.read(appStateProvider).rerouteFailed, isFalse);
    });

    test('電車区間中の逸脱では再検索しない', () async {
      final s = setup();
      addTearDown(s.pos.close);
      addTearDown(s.container.dispose);

      final notifier = s.container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      notifier.go(Screen.nav);

      // sampleRoutePlan の電車区間（原宿→渋谷）から東へ 135m ほど逸脱した点。
      // 閾値（50m）は超えるが、最寄り区間が電車のため再検索は抑制される。
      const offRouteNearTrain = GeoPoint(35.66715, 139.70385);
      for (var i = 0; i < 5; i++) {
        s.pos.add(offRouteNearTrain);
        await tick();
      }

      expect(s.route.calls, 1);
    });

    test('クールダウン中は連続して再検索しない', () async {
      final s = setup();
      addTearDown(s.pos.close);
      addTearDown(s.container.dispose);

      final notifier = s.container.read(appStateProvider.notifier);
      notifier.setDestination('渋谷', latLng: const GeoPoint(35.658, 139.701));
      await notifier.startSearch();
      notifier.go(Screen.nav);

      // 1 回目の再検索を発火させる。
      for (var i = 0; i < 3; i++) {
        s.pos.add(offRoute);
        await tick();
      }
      await tick();
      expect(s.route.calls, 2);

      // 直後に別方向へ逸脱が続いても、30 秒のクールダウン内なので
      // 再検索は走らない（再検索後のルートからも外れた遠方の点を使う）。
      const farOff = GeoPoint(35.50, 139.60);
      for (var i = 0; i < 5; i++) {
        s.pos.add(farOff);
        await tick();
      }
      await tick();

      expect(s.route.calls, 2);
    });
  });
}
