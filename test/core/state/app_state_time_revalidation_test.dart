import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
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

    test('CTA を経由しない nav 入場（deep link 等）でも失効経路を無効化する', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      await notifier.startSearch();

      s.clock.value = DateTime(2026, 7, 13, 14, 40);
      // startNavigation ではなく go(Screen.nav)（router 書き戻し相当）で直接入場。
      notifier.go(Screen.nav);

      final state = s.container.read(appStateProvider);
      expect(state.screen, isNot(Screen.nav));
      expect(state.screen, Screen.home);
      expect(state.route, isNull);
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

/// 可変の現在時刻。`now` を [nowProvider] へ渡し、`value` を書き換えて時間を進める。
class _Clock {
  _Clock(this.value);
  DateTime value;
  DateTime now() => value;
}
