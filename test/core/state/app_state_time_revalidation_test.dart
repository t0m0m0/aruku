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

/// 常に [result] を返し、`plan()` に渡された出発時刻を記録する RouteService。
/// [gate] を渡すと `plan()` はそれが complete するまで待つ（照会中の時間経過を再現）。
class _RecordingRouteService implements RouteService {
  _RecordingRouteService(this.result, {this.gate});
  final RoutePlan result;
  final Completer<void>? gate;
  int calls = 0;
  final List<TimeValue> departures = [];

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
    departures.add(departure);
    if (gate != null) await gate!.future;
    return result;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// [start] を初期時刻とし、`clock.value` を書き換えて時間を進められるコンテナ。
  /// [gate] を渡すと `plan()` はそれが complete するまで待つ。
  ({ProviderContainer container, _RecordingRouteService route, _Clock clock})
  setup(DateTime start, {Completer<void>? gate}) {
    final clock = _Clock(start);
    final route = _RecordingRouteService(sampleRoutePlan, gate: gate);
    final container = ProviderContainer(
      overrides: [
        nowProvider.overrideWithValue(clock.now),
        routeServiceProvider.overrideWithValue(route),
        // オンボーディング済みとして home から開始する（実運用の復帰シナリオ）。
        onboardingCompletedProvider.overrideWithValue(true),
      ],
    );
    addTearDown(container.dispose);
    return (container: container, route: route, clock: clock);
  }

  group('AppNotifier isNow 時刻の再検証（#264）', () {
    test('検索直前に isNow 出発を現在時刻へ更新し、到着で予算幅を保つ', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      // 初期: 出発 09:25 / 予算 60 分。
      expect(s.container.read(appStateProvider).budgetMinutes, 60);

      s.clock.value = DateTime(2026, 7, 13, 14, 40);
      await notifier.startSearch();

      final state = s.container.read(appStateProvider);
      expect(state.departure.isNow, isTrue);
      expect(state.departure.h, 14);
      expect(state.departure.m, 40);
      expect(state.arrival.h, 15);
      expect(state.arrival.m, 40);
      expect(state.budgetMinutes, 60);
      // plan() には更新後の出発が渡る。
      expect(s.route.departures.single.h, 14);
      expect(s.route.departures.single.m, 40);
    });

    test('長時間経過後に結果からナビ開始すると、経路を無効化して再検索を促す', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      await notifier.startSearch();
      expect(s.container.read(appStateProvider).screen, Screen.result);

      s.clock.value = DateTime(2026, 7, 13, 14, 40);
      notifier.startNavigation();

      final state = s.container.read(appStateProvider);
      expect(state.screen, isNot(Screen.nav));
      expect(state.screen, Screen.home);
      expect(state.route, isNull);
      // 自動で再検索は走らない（促すだけ）。
      expect(s.route.calls, 1);
      // 出発は現在時刻へ更新されている。
      expect(state.departure.h, 14);
      expect(state.departure.m, 40);
    });

    test('猶予内に結果からナビ開始すると、ナビへ進み経路を保持する', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      await notifier.startSearch();

      s.clock.value = DateTime(2026, 7, 13, 9, 27);
      notifier.startNavigation();

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.nav);
      expect(state.route, sampleRoutePlan);
    });

    test('アプリ復帰で結果画面の失効経路を無効化する', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      await notifier.startSearch();

      s.clock.value = DateTime(2026, 7, 13, 14, 40);
      notifier.onAppResumed();

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.route, isNull);
      expect(state.departure.h, 14);
      expect(state.departure.m, 40);
    });

    test('復帰時、猶予内なら経路も表示中の出発時刻もそのまま保持する', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      await notifier.startSearch();

      s.clock.value = DateTime(2026, 7, 13, 9, 27);
      notifier.onAppResumed();

      // 経路を表示中は、そのタイムラインが前提とする出発時刻とヘッダーがズレないよう
      // 出発を書き換えない。次の検索が現在時刻へ更新するので正しさは保てる。
      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.result);
      expect(state.route, sampleRoutePlan);
      expect(state.departure.h, 9);
      expect(state.departure.m, 25);
    });

    test('経路が無いホームで復帰すると isNow 出発を現在時刻へ追従させる', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      // 初期状態はホーム・経路なし。
      expect(s.container.read(appStateProvider).route, isNull);

      s.clock.value = DateTime(2026, 7, 13, 14, 40);
      notifier.onAppResumed();

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.departure.h, 14);
      expect(state.departure.m, 40);
      expect(state.arrival.h, 15);
      expect(state.arrival.m, 40);
      expect(state.budgetMinutes, 60);
    });

    test('結果からホームへ退避後に復帰すると、残った失効経路を掃除する', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      await notifier.startSearch();
      // 結果からホームへ戻る（経路は再入場に備えメモリに残る）。
      notifier.go(Screen.home);
      expect(s.container.read(appStateProvider).route, sampleRoutePlan);

      // 猶予超過後に復帰すると、残った失効経路を落として出発も現在時刻へ追従させる。
      s.clock.value = DateTime(2026, 7, 13, 14, 40);
      notifier.onAppResumed();

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.route, isNull);
      expect(state.departure.h, 14);
      expect(state.departure.m, 40);
    });

    test('再検索が失敗しても、残る旧経路は routeAsOf を保持し失効判定の対象であり続ける', () async {
      final clock = _Clock(DateTime(2026, 7, 13, 9, 25));
      final route = _FlakyRouteService(sampleRoutePlan);
      final container = ProviderContainer(
        overrides: [
          nowProvider.overrideWithValue(clock.now),
          routeServiceProvider.overrideWithValue(route),
          onboardingCompletedProvider.overrideWithValue(true),
        ],
      );
      addTearDown(container.dispose);
      final notifier = container.read(appStateProvider.notifier);

      // 1 回目は成功して経路と routeAsOf を確定。
      await notifier.startSearch();
      expect(container.read(appStateProvider).routeAsOf, isNotNull);

      // 2 回目は失敗。旧経路も routeAsOf も残す（掃除すると失効判定から外れてしまう）。
      route.failNext = true;
      await notifier.startSearch();
      final state = container.read(appStateProvider);
      expect(state.screen, Screen.error);
      expect(state.route, sampleRoutePlan);
      expect(state.routeAsOf, isNotNull);

      // 猶予超過後は、経路が残っていても失効と判定される。
      clock.value = DateTime(2026, 7, 13, 9, 31);
      expect(state.isNowRouteExpired(clock.value), isTrue);
    });

    test('照会中の復帰では出発を書き換えず、猶予内完了で表示と経路の前提時刻が一致する', () async {
      final gate = Completer<void>();
      final s = setup(DateTime(2026, 7, 13, 9, 25), gate: gate);
      final notifier = s.container.read(appStateProvider.notifier);

      final search = notifier.startSearch();
      await Future<void>.delayed(Duration.zero);
      expect(s.container.read(appStateProvider).screen, Screen.loading);

      // 猶予内（2分後）に復帰。in-flight の plan は 9:25 の前提で進行中なので、
      // ここで出発を 9:27 へ書き換えるとタイムラインとヘッダーがズレる。
      s.clock.value = DateTime(2026, 7, 13, 9, 27);
      notifier.onAppResumed();

      gate.complete();
      await search;

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.result);
      // 出発は検索開始時刻（9:25）のまま。復帰時刻では書き換えない。
      expect(state.departure.h, 9);
      expect(state.departure.m, 25);
    });

    test('固定出発の検索は routeAsOf を持たず、時間が経過しても失効しない', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 9,
        m: 0,
        dateOffset: 1,
      );
      await notifier.startSearch();

      final state = s.container.read(appStateProvider);
      expect(state.routeAsOf, isNull);
      // 終日経過しても固定出発は失効しない（routeAsOf が無い）。
      expect(state.isNowRouteExpired(DateTime(2026, 7, 13, 23, 59)), isFalse);
    });

    test('now 経路を残したまま出発を固定へ変え、再検索が失敗しても now 経路は失効判定され続ける', () async {
      final clock = _Clock(DateTime(2026, 7, 13, 9, 25));
      final route = _FlakyRouteService(sampleRoutePlan);
      final container = ProviderContainer(
        overrides: [
          nowProvider.overrideWithValue(clock.now),
          routeServiceProvider.overrideWithValue(route),
          onboardingCompletedProvider.overrideWithValue(true),
        ],
      );
      addTearDown(container.dispose);
      final notifier = container.read(appStateProvider.notifier);

      // isNow で検索して now 経路を確定（routeAsOf 付き）。
      await notifier.startSearch();
      expect(container.read(appStateProvider).routeAsOf, isNotNull);

      // ホームへ退避し、出発を固定時刻へ変更（フォームは isNow=false になる）。
      notifier.go(Screen.home);
      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 9,
        m: 0,
        dateOffset: 1,
      );
      // 再検索は失敗。旧 now 経路と routeAsOf はそのまま残る。
      route.failNext = true;
      await notifier.startSearch();
      final state = container.read(appStateProvider);
      expect(state.route, sampleRoutePlan);
      expect(state.departure.isNow, isFalse);

      // フォームが固定に変わっても、残った now 経路は経路メタデータ基準で失効する。
      clock.value = DateTime(2026, 7, 13, 9, 31);
      expect(state.isNowRouteExpired(clock.value), isTrue);
    });

    test('猶予内の再検索が失敗しても、出発ヘッダーは旧経路の前提時刻に一致し続ける', () async {
      final clock = _Clock(DateTime(2026, 7, 13, 9, 25));
      final route = _FlakyRouteService(sampleRoutePlan);
      final container = ProviderContainer(
        overrides: [
          nowProvider.overrideWithValue(clock.now),
          routeServiceProvider.overrideWithValue(route),
          onboardingCompletedProvider.overrideWithValue(true),
        ],
      );
      addTearDown(container.dispose);
      final notifier = container.read(appStateProvider.notifier);

      // 9:25 の isNow 検索が成功。出発 9:25 で経路確定。
      await notifier.startSearch();
      expect(container.read(appStateProvider).departure.m, 25);
      notifier.go(Screen.home);

      // 9:27 に再検索するが失敗。旧経路（9:25 前提）を残す。
      clock.value = DateTime(2026, 7, 13, 9, 27);
      route.failNext = true;
      await notifier.startSearch();

      final state = container.read(appStateProvider);
      expect(state.screen, Screen.error);
      expect(state.route, sampleRoutePlan);
      // 出発は確定していないので 9:25 のまま。旧経路のタイムラインとズレない。
      expect(state.departure.h, 9);
      expect(state.departure.m, 25);
    });

    test('照会中にバックグラウンド滞在で失効すると、完了しても結果を表示しない', () async {
      final gate = Completer<void>();
      final s = setup(DateTime(2026, 7, 13, 9, 25), gate: gate);
      final notifier = s.container.read(appStateProvider.notifier);

      final search = notifier.startSearch();
      // 照会は gate 待ちで未完了。ローディング中に長時間経過して復帰する。
      await Future<void>.delayed(Duration.zero);
      expect(s.container.read(appStateProvider).screen, Screen.loading);
      s.clock.value = DateTime(2026, 7, 13, 14, 40);
      notifier.onAppResumed();

      // 応答が後着しても、古い前提の結果は publish されず home へ戻る。
      gate.complete();
      await search;

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.route, isNull);
    });

    test('ナビ中のアプリ復帰では経路を無効化しない（歩行を継続する）', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      await notifier.startSearch();
      notifier.startNavigation();
      expect(s.container.read(appStateProvider).screen, Screen.nav);

      // ナビ中に長時間経過して復帰しても、経路もナビ画面も維持される。
      s.clock.value = DateTime(2026, 7, 13, 14, 40);
      notifier.onAppResumed();

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.nav);
      expect(state.route, sampleRoutePlan);
    });

    test('固定出発から始めても、リルート後の経路は now 基準として routeAsOf を持つ', () async {
      final controller = StreamController<GeoPoint>.broadcast();
      final clock = _Clock(DateTime(2026, 7, 13, 9, 25));
      final route = _RecordingRouteService(sampleRoutePlan);
      final container = ProviderContainer(
        overrides: [
          nowProvider.overrideWithValue(clock.now),
          routeServiceProvider.overrideWithValue(route),
          onboardingCompletedProvider.overrideWithValue(true),
          locationServiceProvider.overrideWithValue(
            _StreamLocationService(controller),
          ),
        ],
      );
      addTearDown(controller.close);
      addTearDown(container.dispose);
      final notifier = container.read(appStateProvider.notifier);

      // 固定出発で検索 → 初期経路は now 基準でないため routeAsOf は付かない。
      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 9,
        m: 0,
        dateOffset: 1,
      );
      await notifier.startSearch();
      expect(container.read(appStateProvider).routeAsOf, isNull);

      notifier.go(Screen.nav);
      // 経路から外れ続けてリルート（isNow:true で引き直し）を発火させる。
      for (var i = 0; i < 3; i++) {
        controller.add(const GeoPoint(35.69, 139.85));
        await Future<void>.delayed(Duration.zero);
      }
      await Future<void>.delayed(Duration.zero);

      // 差し替え後の経路は now 基準なので、失効判定の対象として routeAsOf を持つ。
      expect(container.read(appStateProvider).routeAsOf, isNotNull);
    });

    test('将来の固定出発（isNow=false）は時間が経過しても失効しない', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      // 明日 09:00 出発（固定）に変更する。
      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 9,
        m: 0,
        dateOffset: 1,
      );
      await notifier.startSearch();
      final departureAfterSearch = s.container.read(appStateProvider).departure;
      expect(departureAfterSearch.isNow, isFalse);

      s.clock.value = DateTime(2026, 7, 13, 23, 59);
      notifier.startNavigation();

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.nav);
      expect(state.route, sampleRoutePlan);
      // 固定出発は現在時刻で書き換えない。
      expect(state.departure.h, 9);
      expect(state.departure.m, 0);
      expect(state.departure.dateOffset, 1);
    });
  });
}

/// `failNext` が true の呼び出しだけ例外を投げる RouteService（再検索失敗の再現）。
class _FlakyRouteService implements RouteService {
  _FlakyRouteService(this.result);
  final RoutePlan result;
  bool failNext = false;

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
    if (failNext) throw const RouteException('fail');
    return result;
  }
}

/// 位置ストリームを外部制御できる LocationService（リルート発火の再現用）。
class _StreamLocationService implements LocationService {
  _StreamLocationService(this._controller);
  final StreamController<GeoPoint> _controller;

  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => _controller.stream;
}

/// 可変の現在時刻。`now` を [nowProvider] へ渡し、`value` を書き換えて時間を進める。
class _Clock {
  _Clock(this.value);
  DateTime value;
  DateTime now() => value;
}
