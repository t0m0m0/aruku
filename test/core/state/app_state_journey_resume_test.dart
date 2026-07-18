import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/health_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/route_plan_fixtures.dart';

/// `request()` の戻り値を差し替えられる LocationService（復帰時の単発再取得の再現用）。
/// positionStream は使わない（結果ハブは GPS 追跡を持たない）。
class _FakeLocationService implements LocationService {
  _FakeLocationService([this.next = const LocationDenied()]);
  LocationState next;

  @override
  Future<LocationState> request() async => next;

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
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

class _FakeActivityService implements ActivityService {
  _FakeActivityService(this._controller);
  final StreamController<ActivitySnapshot> _controller;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => _controller.stream;
}

class _FakeHealthService implements HealthService {
  WalkingWorkout? written;
  int writeCount = 0;

  @override
  Future<bool> requestAuthorization() async => true;

  @override
  Future<bool> writeWalkingWorkout(WalkingWorkout workout) async {
    written = workout;
    writeCount++;
    return true;
  }
}

class _Clock {
  _Clock(this.value);
  DateTime value;
  DateTime now() => value;
}

/// 2 つの徒歩区間の終点をほぼ同一座標に重ねた経路。復帰が「近くにいる」だけで
/// 複数区間を一気に進めないこと（1 区間まで）を固定するために使う。
const _coincidentEndpointsPlan = RoutePlan(
  from: 'A',
  to: 'C',
  totalKm: 1.0,
  totalMin: 20,
  budgetMin: 30,
  kcal: 50,
  walkKm: 1.0,
  walkRatio: 1.0,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: 'A',
      toName: 'B',
      km: 0.5,
      minutes: 10,
      kcal: 25,
      polyline: [GeoPoint(35.0, 139.0), GeoPoint(35.001, 139.0)],
    ),
    RouteSegment(
      type: SegmentType.walk,
      fromName: 'B',
      toName: 'C',
      km: 0.5,
      minutes: 10,
      kcal: 25,
      polyline: [GeoPoint(35.001, 139.0), GeoPoint(35.001, 139.0)],
    ),
  ],
  timelineNodes: [],
);

/// 徒歩1区間だけの経路。到着で行程が全区間完了へ到達する再現に使う。
const _singleWalkPlan = RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: 0.5,
  totalMin: 10,
  budgetMin: 30,
  kcal: 25,
  walkKm: 0.5,
  walkRatio: 1.0,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: 'A',
      toName: 'B',
      km: 0.5,
      minutes: 10,
      kcal: 25,
      polyline: [GeoPoint(35.0, 139.0), GeoPoint(35.001, 139.0)],
    ),
  ],
  timelineNodes: [],
);

/// 徒歩区間0（[sampleRoutePlan]）の終点座標。到着とみなされる位置。
const _leg0End = GeoPoint(35.6703, 139.7027);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> settle() async {
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
  }

  Future<
    ({
      ProviderContainer container,
      _FakeLocationService location,
      StreamController<ActivitySnapshot> activity,
      _FakeHealthService health,
      _Clock clock,
    })
  >
  makeHarness({
    RoutePlan plan = sampleRoutePlan,
    LocationState location = const LocationDenied(),
    bool healthKitEnabled = false,
    DateTime? start,
  }) async {
    final clock = _Clock(start ?? DateTime(2026, 7, 18, 9, 0));
    SharedPreferences.setMockInitialValues({
      'settings.v1': jsonEncode({
        'notificationsEnabled': false,
        'weeklyGoalKm': 10.0,
        'healthKitEnabled': healthKitEnabled,
      }),
    });
    final loc = _FakeLocationService(location);
    final activity = StreamController<ActivitySnapshot>();
    final health = _FakeHealthService();
    final container = ProviderContainer(
      overrides: [
        routeServiceProvider.overrideWithValue(_FixedRouteService(plan)),
        locationServiceProvider.overrideWithValue(loc),
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(activity),
        ),
        healthServiceProvider.overrideWithValue(health),
        onboardingCompletedProvider.overrideWithValue(true),
        nowProvider.overrideWithValue(clock.now),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(activity.close);
    await container.read(settingsProvider.future);
    return (
      container: container,
      location: loc,
      activity: activity,
      health: health,
      clock: clock,
    );
  }

  group('復帰時の区間再評価（#305）', () {
    test('現在地が現在区間の終点閾値内なら区間が1つ進む', () async {
      final h = await makeHarness();
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 0);

      h.location.next = const LocationAvailable(_leg0End);
      await notifier.onAppResumed();

      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 1);
    });

    test('次区間の終点にも近い位置でも一度の復帰で進むのは1区間まで', () async {
      final h = await makeHarness(plan: _coincidentEndpointsPlan);
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      // leg0 と leg1 の終点は同一座標。1 度の復帰では 1 区間だけ進む。
      h.location.next = const LocationAvailable(GeoPoint(35.001, 139.0));
      await notifier.onAppResumed();

      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 1);
    });

    test('終点から遠ければ区間は進まず journey は維持される', () async {
      final h = await makeHarness();
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      h.location.next = const LocationAvailable(GeoPoint(35.0, 139.0));
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.journey, isNotNull);
      expect(state.journey!.currentLegIndex, 0);
      expect(state.route, sampleRoutePlan);
    });

    test('現在地取得失敗（Denied）では区間を自動完了させない', () async {
      final h = await makeHarness();
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      h.location.next = const LocationDenied();
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.journey!.currentLegIndex, 0);
      expect(state.locationState, isA<LocationDenied>());
    });

    test('現在地取得失敗（Unavailable）では区間を自動完了させない', () async {
      final h = await makeHarness();
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      h.location.next = const LocationUnavailable();
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.journey!.currentLegIndex, 0);
      expect(state.locationState, isA<LocationUnavailable>());
    });

    test('journey が無ければ復帰時の区間再評価は走らない（現在地を再取得しない）', () async {
      final h = await makeHarness();
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      // journey 未開始。結果画面のまま。

      // 復帰時に区間到着扱いになる位置でも、journey が無ければ何も起きない。
      h.location.next = const LocationAvailable(_leg0End);
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.journey, isNull);
      expect(state.screen, Screen.result);
    });

    test('isNow 経路が失効していれば journey ごと無効化される（既存 #264 との整合）', () async {
      final h = await makeHarness(start: DateTime(2026, 7, 18, 9, 0));
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      expect(h.container.read(appStateProvider).journey, isNotNull);

      // 猶予超過。復帰で区間再評価より前に失効判定が経路と journey を落とす。
      h.clock.value = DateTime(2026, 7, 18, 14, 40);
      h.location.next = const LocationAvailable(_leg0End);
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.route, isNull);
      expect(state.journey, isNull);
    });

    test('外部URL往復（背景化→復帰）で journey と route が保持される', () async {
      final h = await makeHarness();
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      final journey = h.container.read(appStateProvider).journey;

      // 外部地図表示中に現在地が終点から離れている（まだ到着していない）。
      h.location.next = const LocationAvailable(GeoPoint(35.0, 139.0));
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.journey, same(journey));
      expect(state.route, sampleRoutePlan);
      expect(state.screen, Screen.result);
    });
  });

  group('外部アプリ往復中の歩数の追いつき（#305）', () {
    test('バックグラウンド中に増えた歩数が復帰後の todaySteps と行程歩数に反映される', () async {
      final h = await makeHarness();
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      final startSteps = h.container.read(appStateProvider).journey!.startSteps;
      expect(startSteps, 100);

      // 外部地図で歩いた分がストリームで後追いされる（累積 600）。
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();
      h.location.next = const LocationAvailable(GeoPoint(35.0, 139.0));
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.todaySteps, 600);
      expect(state.todaySteps - state.journey!.startSteps, 500);
    });
  });

  group('行程セッションの終了と HealthKit（#305）', () {
    test('全区間完了時に WalkingWorkout が書かれ、歩数に外部利用中の差分が含まれる', () async {
      final h = await makeHarness(healthKitEnabled: true);
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      // 行程中（外部地図含む）に歩数が 100→600 へ増える。
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();

      // 全区間完了（番兵値）へ到達させる。
      notifier.advanceToLeg(sampleRoutePlan.segments.length);
      await settle();

      expect(h.health.writeCount, 1);
      final w = h.health.written!;
      expect(w.steps, 500);
      final snap = ActivitySnapshot.fromSteps(500);
      expect(w.km, snap.km);
      expect(w.kcal, snap.kcal);
      expect(w.start, h.container.read(appStateProvider).journey!.startedAt);
      expect(w.end.isBefore(w.start), isFalse);
    });

    test('復帰時の到着で全区間完了に達したら WalkingWorkout を書く', () async {
      final h = await makeHarness(
        plan: _singleWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(0));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      h.activity.add(ActivitySnapshot.fromSteps(400));
      await settle();

      // 復帰時に終点へ到着 → 唯一の区間が完了し番兵値へ達する。
      h.location.next = const LocationAvailable(GeoPoint(35.001, 139.0));
      await notifier.onAppResumed();
      await settle();

      expect(h.health.writeCount, 1);
      expect(h.health.written!.steps, 400);
    });

    test('連携オフなら全区間完了でも WalkingWorkout を書かない', () async {
      final h = await makeHarness(healthKitEnabled: false);
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();

      notifier.advanceToLeg(sampleRoutePlan.segments.length);
      await settle();

      expect(h.health.writeCount, 0);
    });

    test('途中でのリセット（新規検索）では WalkingWorkout を書かない', () async {
      final h = await makeHarness(healthKitEnabled: true);
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      // 途中まで進めてから新規検索でリセット（行程を放棄）。
      notifier.advanceToLeg(1);
      await notifier.startSearch();
      await settle();

      expect(h.container.read(appStateProvider).journey, isNull);
      expect(h.health.writeCount, 0);
    });

    test('全区間完了へ再度到達しても二重に書き込まない', () async {
      final h = await makeHarness(healthKitEnabled: true);
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();

      notifier.advanceToLeg(sampleRoutePlan.segments.length);
      notifier.advanceToLeg(sampleRoutePlan.segments.length);
      await settle();

      expect(h.health.writeCount, 1);
    });
  });
}
