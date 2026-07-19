import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
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
  final List<Future<LocationState>> _queuedRequests = [];

  void enqueue(Future<LocationState> result) => _queuedRequests.add(result);

  @override
  Future<LocationState> request() => _queuedRequests.isEmpty
      ? Future.value(next)
      : _queuedRequests.removeAt(0);

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

/// 終点 geometry を持たず、復帰時の自動到着判定を手動完了へフォールバックする経路。
const _singleEmptyWalkPlan = RoutePlan(
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
    ),
  ],
  timelineNodes: [],
);

/// 連続する手動完了でも、行程全体で復帰後の歩数同期を引き継ぐ経路。
const _twoEmptyWalkPlan = RoutePlan(
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
    ),
    RouteSegment(
      type: SegmentType.walk,
      fromName: 'B',
      toName: 'C',
      km: 0.5,
      minutes: 10,
      kcal: 25,
    ),
  ],
  timelineNodes: [],
);

/// 徒歩で増えた歩数を保持したまま、歩数が増えない最終電車区間へ進む経路。
const _walkThenTrainPlan = RoutePlan(
  from: 'A',
  to: 'C',
  totalKm: 5.5,
  totalMin: 20,
  budgetMin: 30,
  kcal: 25,
  walkKm: 0.5,
  walkRatio: 0.09,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: 'A',
      toName: 'B',
      km: 0.5,
      minutes: 10,
      kcal: 25,
    ),
    RouteSegment(
      type: SegmentType.train,
      fromName: 'B',
      toName: 'C',
      km: 5.0,
      minutes: 10,
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
    // 履歴ロードを遅延させ、ロード完了前に行程を開始する状況を再現する（基準歩数
    // ガードのテスト用）。null なら即時（実運用の通常起動）。
    Duration? historyLoadDelay,
    int recordedTodaySteps = 0,
  }) async {
    final clock = _Clock(start ?? DateTime(2026, 7, 18, 9, 0));
    SharedPreferences.setMockInitialValues({
      'settings.v1': jsonEncode({
        'notificationsEnabled': false,
        'weeklyGoalKm': 10.0,
        'healthKitEnabled': healthKitEnabled,
      }),
    });
    ActivityLogRepository? seededRepo;
    if (historyLoadDelay != null) {
      final prefs = await SharedPreferences.getInstance();
      seededRepo = ActivityLogRepository(prefs);
      if (recordedTodaySteps > 0) {
        await seededRepo.upsert(
          DailyActivity(date: DateTime.now(), steps: recordedTodaySteps),
        );
      }
    }
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
        if (historyLoadDelay != null)
          activityLogRepositoryProvider.overrideWith((ref) async {
            await Future<void>.delayed(historyLoadDelay);
            return seededRepo!;
          }),
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
      expect(state.journeyManualCompletionAvailable, isTrue);
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
      expect(state.journeyManualCompletionAvailable, isTrue);
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

    test('行程進行中は失効超過でも復帰で route/journey を維持し区間を再評価する', () async {
      final h = await makeHarness(start: DateTime(2026, 7, 18, 9, 0));
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      expect(h.container.read(appStateProvider).journey, isNotNull);

      // 5分超の徒歩区間を外部地図で歩いて復帰。失効していても行程は消さず、
      // 現在地が現在区間の終点閾値内なら区間を1つ進める（#305 修正1）。
      h.clock.value = DateTime(2026, 7, 18, 14, 40);
      h.location.next = const LocationAvailable(_leg0End);
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.route, sampleRoutePlan);
      expect(state.journey, isNotNull);
      expect(state.journey!.currentLegIndex, 1);
    });

    test('journey が無ければ失効超過の復帰で従来どおり経路を無効化する', () async {
      final h = await makeHarness(start: DateTime(2026, 7, 18, 9, 0));
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      await notifier.startSearch();
      // 行程は未開始（結果画面のまま失効を迎える）。

      h.clock.value = DateTime(2026, 7, 18, 14, 40);
      h.location.next = const LocationAvailable(_leg0End);
      await notifier.onAppResumed();

      final state = h.container.read(appStateProvider);
      expect(state.route, isNull);
      expect(state.journey, isNull);
      expect(state.screen, Screen.home);
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

    test('結果ハブから home へ離脱すると行程を破棄し、復帰しても完了扱いにしない', () async {
      final h = await makeHarness(
        plan: _singleWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();

      // 結果ハブを離れた時点で行程は放棄。システム back とヘッダー back は
      // どちらも syncScreen(Screen.home) を通る。
      notifier.go(Screen.home);
      expect(h.container.read(appStateProvider).journey, isNull);

      // その後に終点付近で復帰しても、隠れた行程を完了させたり
      // WalkingWorkout を書き込んだりしない。
      h.location.next = const LocationAvailable(GeoPoint(35.001, 139.0));
      await notifier.onAppResumed();
      await settle();

      final state = h.container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.journey, isNull);
      expect(h.health.writeCount, 0);
    });

    test('結果ハブから nav へ離脱した行程は破棄し、home 復帰後も保持しない', () async {
      final h = await makeHarness(
        plan: _singleWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();

      notifier.startNavigation();
      expect(h.container.read(appStateProvider).screen, Screen.nav);
      expect(h.container.read(appStateProvider).journey, isNull);

      notifier.go(Screen.home);
      h.location.next = const LocationAvailable(GeoPoint(35.001, 139.0));
      await notifier.onAppResumed();
      await settle();

      expect(h.container.read(appStateProvider).journey, isNull);
      expect(h.health.writeCount, 0);
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

    test('最終区間の到着判定が先でも復帰後の歩数更新を待って WalkingWorkout を書く', () async {
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

      // 復帰時は位置取得が先に終点到着を返す。外部 Google Maps 中の歩数は
      // pedometer ストリームから少し遅れて届く競合を再現する。
      h.location.next = const LocationAvailable(GeoPoint(35.001, 139.0));
      final resumed = notifier.onAppResumed();
      await settle();
      expect(h.health.writeCount, 0);

      h.activity.add(ActivitySnapshot.fromSteps(400));
      await resumed;
      await settle();

      expect(h.health.writeCount, 1);
      expect(h.health.written!.steps, 400);
    });

    test('後続の復帰に置き換えられた到着判定を歩数同期成功として完了しない', () async {
      final h = await makeHarness(
        plan: _singleWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      // 外部利用分の全量が未反映で、一部の50歩だけが見えている状態。
      h.activity.add(ActivitySnapshot.fromSteps(150));
      await settle();

      final firstLocation = Completer<LocationState>();
      h.location.enqueue(firstLocation.future);
      final firstResume = notifier.onAppResumed();
      await settle();

      final secondLocation = Completer<LocationState>();
      h.location.enqueue(secondLocation.future);
      final secondResume = notifier.onAppResumed();
      await settle();

      // 古い位置取得だけが最終区間の到着を返す。後続復帰の開始は歩数更新ではないため、
      // この結果で行程完了や50歩のWorkout書き込みをしてはいけない。
      firstLocation.complete(const LocationAvailable(GeoPoint(35.001, 139.0)));
      await firstResume;
      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 0);
      expect(h.health.writeCount, 0);

      secondLocation.complete(const LocationAvailable(GeoPoint(35.0, 139.0)));
      await secondResume;
      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 0);
      expect(h.health.writeCount, 0);
    });

    test('手動の最終区間完了も復帰後の歩数更新を待って WalkingWorkout を書く', () async {
      final h = await makeHarness(
        plan: _singleEmptyWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      // geometry 欠落などで自動到着に進めない復帰を再現する。復帰処理自体が
      // 終わった後に手動完了を押しても、遅れて届く歩数を待つ必要がある。
      h.location.next = const LocationDenied();
      await notifier.onAppResumed();
      final completed = notifier.advanceCurrentLegManually();
      await settle();
      expect(h.health.writeCount, 0);
      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 0);

      h.activity.add(ActivitySnapshot.fromSteps(600));
      await completed;
      await settle();

      expect(
        h.container.read(appStateProvider).journey!.currentLegIndex,
        _singleEmptyWalkPlan.segments.length,
      );
      expect(h.health.writeCount, 1);
      expect(h.health.written!.steps, 500);
    });

    test('連続する手動区間でも最終完了まで復帰後の歩数同期を引き継ぐ', () async {
      final h = await makeHarness(
        plan: _twoEmptyWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      // 復帰前には一部の歩数しか反映されていない。最初の手動区間を進めても、
      // 同じ行程の最終区間では復帰後の歩数更新を引き続き待つ必要がある。
      h.activity.add(ActivitySnapshot.fromSteps(150));
      await settle();
      h.location.next = const LocationDenied();
      await notifier.onAppResumed();
      await notifier.advanceCurrentLegManually();
      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 1);
      expect(h.health.writeCount, 0);

      final completed = notifier.advanceCurrentLegManually();
      await settle();
      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 1);
      expect(h.health.writeCount, 0);

      h.activity.add(ActivitySnapshot.fromSteps(600));
      await completed;
      await settle();

      expect(
        h.container.read(appStateProvider).journey!.currentLegIndex,
        _twoEmptyWalkPlan.segments.length,
      );
      expect(h.health.writeCount, 1);
      expect(h.health.written!.steps, 500);
    });

    test('歩数が増えない最終電車区間は新しい活動イベントを待たずに Workout を書く', () async {
      final h = await makeHarness(
        plan: _walkThenTrainPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      // 最初の徒歩区間で増えた歩数は既に反映済み。最終電車区間では歩数が
      // 増えないため、復帰後の新しい活動イベントなしで現在値を確定できる。
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();
      await notifier.advanceCurrentLegManually();
      expect(h.container.read(appStateProvider).journey!.currentLegIndex, 1);

      h.location.next = const LocationAvailable(GeoPoint(35.001, 139.0));
      await notifier.onAppResumed();
      await settle();

      expect(
        h.container.read(appStateProvider).journey!.currentLegIndex,
        _walkThenTrainPlan.segments.length,
      );
      expect(h.health.writeCount, 1);
      expect(h.health.written!.steps, 500);
    });

    test('handoff中の歩数が復帰前に反映済みなら追加イベントを待たずに Workout を書く', () async {
      final h = await makeHarness(
        plan: _singleWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      final route = h.container.read(appStateProvider).route!;

      // URL起動成功後の境界を通して行程を開始し、外部アプリ中の活動イベントが
      // onAppResumed より先に届く実機の順序を再現する。
      notifier.startJourneyIfHandoffStillCurrent(
        expectedRoute: route,
        expectedJourney: null,
        expectedLegIndex: 0,
      );
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();

      h.location.next = const LocationAvailable(GeoPoint(35.001, 139.0));
      await notifier.onAppResumed();
      await settle();

      expect(
        h.container.read(appStateProvider).journey!.currentLegIndex,
        _singleWalkPlan.segments.length,
      );
      expect(h.health.writeCount, 1);
      expect(h.health.written!.steps, 500);
    });

    test('復帰後の歩数更新が上限まで来なければ不正確な Workout を捨てて行程だけ完了する', () async {
      final h = await makeHarness(
        plan: _singleWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();

      // 復帰前に一部だけ（50歩）反映された状態。復帰後の更新が来ない場合、この
      // 不完全な値で Workout を確定せず、待機上限後は行程進捗だけを完了させる。
      h.activity.add(ActivitySnapshot.fromSteps(150));
      await settle();
      h.location.next = const LocationAvailable(GeoPoint(35.001, 139.0));
      await notifier.onAppResumed();
      await settle();

      expect(
        h.container.read(appStateProvider).journey!.currentLegIndex,
        _singleWalkPlan.segments.length,
      );
      expect(h.health.writeCount, 0);
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

  group('行程完了の基準歩数ガード（#305 修正2）', () {
    test('履歴ロード完了前に開始した行程は全区間完了でも WalkingWorkout を書かない', () async {
      final h = await makeHarness(
        plan: _singleWalkPlan,
        healthKitEnabled: true,
        historyLoadDelay: const Duration(milliseconds: 30),
        recordedTodaySteps: 1000,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      // 履歴ロード（30ms）未完了のうちに検索・行程開始する。startSearch の await は
      // マイクロタスクだけを回すので 30ms タイマーはまだ発火しない。
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      expect(
        h.container.read(appStateProvider).journey!.startBaselineValid,
        isFalse,
      );

      // セッション歩数が届き、ロード完了後に基準 1000 が乗る（累積が過大になる）。
      h.activity.add(ActivitySnapshot.fromSteps(500));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      notifier.advanceToLeg(_singleWalkPlan.segments.length);
      await settle();

      expect(h.health.writeCount, 0);
    });

    test('履歴ロード後に開始した行程は全区間完了で WalkingWorkout を書く', () async {
      final h = await makeHarness(
        plan: _singleWalkPlan,
        healthKitEnabled: true,
      );
      final notifier = h.container.read(appStateProvider.notifier);
      await settle();
      h.activity.add(ActivitySnapshot.fromSteps(100));
      await settle();
      await notifier.startSearch();
      notifier.startJourney();
      expect(
        h.container.read(appStateProvider).journey!.startBaselineValid,
        isTrue,
      );
      h.activity.add(ActivitySnapshot.fromSteps(600));
      await settle();

      notifier.advanceToLeg(_singleWalkPlan.segments.length);
      await settle();

      expect(h.health.writeCount, 1);
      expect(h.health.written!.steps, 500);
    });
  });
}
