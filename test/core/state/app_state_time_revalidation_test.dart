import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/route_plan_fixtures.dart';

/// 常に [plan] を返し、`plan()` に渡された出発時刻を記録するだけの RouteService。
class _RecordingRouteService implements RouteService {
  _RecordingRouteService(this.result);
  final RoutePlan result;
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
    return result;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// [start] を初期時刻とし、`clock.value` を書き換えて時間を進められるコンテナ。
  ({ProviderContainer container, _RecordingRouteService route, _Clock clock})
  setup(DateTime start) {
    final clock = _Clock(start);
    final route = _RecordingRouteService(sampleRoutePlan);
    final container = ProviderContainer(
      overrides: [
        nowProvider.overrideWithValue(clock.now),
        routeServiceProvider.overrideWithValue(route),
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

    test('復帰時、猶予内なら経路を保持し出発だけ更新する', () async {
      final s = setup(DateTime(2026, 7, 13, 9, 25));
      final notifier = s.container.read(appStateProvider.notifier);
      await notifier.startSearch();

      s.clock.value = DateTime(2026, 7, 13, 9, 27);
      notifier.onAppResumed();

      final state = s.container.read(appStateProvider);
      expect(state.screen, Screen.result);
      expect(state.route, sampleRoutePlan);
      expect(state.departure.h, 9);
      expect(state.departure.m, 27);
      expect(state.budgetMinutes, 60);
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
