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

/// 可変の現在時刻。`now` を [nowProvider] へ渡し、`value` を書き換えて時間を進める。
class _Clock {
  _Clock(this.value);
  DateTime value;
  DateTime now() => value;
}

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
  alternatives: [sampleAlternativeArrTime, sampleAlternativeTimelineNode],
);

ProviderContainer _containerWith(RoutePlan plan, {_Clock? clock}) {
  final container = ProviderContainer(
    overrides: [
      routeServiceProvider.overrideWithValue(_FixedRouteService(plan)),
      onboardingCompletedProvider.overrideWithValue(true),
      if (clock != null) nowProvider.overrideWithValue(clock.now),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  group('AppNotifier.startJourney', () {
    test('index0・開始時刻・開始歩数付きで journey を設定する', () async {
      final clock = _Clock(DateTime(2026, 7, 18, 9, 30));
      final container = _containerWith(sampleRoutePlan, clock: clock);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();

      clock.value = DateTime(2026, 7, 18, 9, 31);
      notifier.startJourney();

      final state = container.read(appStateProvider);
      expect(state.journey, isNotNull);
      expect(state.journey!.currentLegIndex, 0);
      expect(state.journey!.startedAt, DateTime(2026, 7, 18, 9, 31));
      expect(state.journey!.startSteps, state.todaySteps);
    });

    test('route 未確定なら no-op', () {
      final container = _containerWith(sampleRoutePlan);
      final notifier = container.read(appStateProvider.notifier);

      notifier.startJourney();

      expect(container.read(appStateProvider).journey, isNull);
    });

    test('二度目の startJourney は巻き戻さない', () async {
      final clock = _Clock(DateTime(2026, 7, 18, 9, 30));
      final container = _containerWith(sampleRoutePlan, clock: clock);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();

      notifier.startJourney();
      final first = container.read(appStateProvider).journey;

      clock.value = DateTime(2026, 7, 18, 10, 0);
      notifier.startJourney();

      expect(container.read(appStateProvider).journey, same(first));
    });
  });

  group('AppNotifier.advanceToLeg', () {
    test('journey がある場合 currentLegIndex を更新する', () async {
      final container = _containerWith(sampleRoutePlan);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      notifier.startJourney();

      notifier.advanceToLeg(1);

      expect(container.read(appStateProvider).journey!.currentLegIndex, 1);
    });

    test('index は segments.length を上限にクランプする（全区間完了の番兵値）', () async {
      final container = _containerWith(sampleRoutePlan);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      notifier.startJourney();

      notifier.advanceToLeg(999);

      expect(
        container.read(appStateProvider).journey!.currentLegIndex,
        sampleRoutePlan.segments.length,
      );
    });

    test('index は 0 を下限にクランプする', () async {
      final container = _containerWith(sampleRoutePlan);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      notifier.startJourney();

      notifier.advanceToLeg(-1);

      expect(container.read(appStateProvider).journey!.currentLegIndex, 0);
    });

    test('journey が無ければ no-op', () async {
      final container = _containerWith(sampleRoutePlan);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();

      notifier.advanceToLeg(1);

      expect(container.read(appStateProvider).journey, isNull);
    });

    test('route が無ければ no-op', () {
      final container = _containerWith(sampleRoutePlan);
      final notifier = container.read(appStateProvider.notifier);

      notifier.advanceToLeg(1);

      expect(container.read(appStateProvider).journey, isNull);
    });

    test('開始時刻・開始歩数は書き換えない', () async {
      final clock = _Clock(DateTime(2026, 7, 18, 9, 30));
      final container = _containerWith(sampleRoutePlan, clock: clock);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      notifier.startJourney();
      final before = container.read(appStateProvider).journey!;

      clock.value = DateTime(2026, 7, 18, 9, 40);
      notifier.advanceToLeg(1);

      final after = container.read(appStateProvider).journey!;
      expect(after.startedAt, before.startedAt);
      expect(after.startSteps, before.startSteps);
    });
  });

  group('journey のリセット', () {
    test('selectAlternative で journey をリセットする', () async {
      final container = _containerWith(_winnerWithAlternatives);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      notifier.startJourney();
      expect(container.read(appStateProvider).journey, isNotNull);

      notifier.selectAlternative(0);

      expect(container.read(appStateProvider).journey, isNull);
    });

    test('新規検索成功で前の journey をリセットする', () async {
      final container = _containerWith(sampleRoutePlan);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      notifier.startJourney();
      expect(container.read(appStateProvider).journey, isNotNull);

      await notifier.startSearch();

      expect(container.read(appStateProvider).journey, isNull);
    });

    test('無関係な状態更新では journey を維持する', () async {
      final container = _containerWith(sampleRoutePlan);
      final notifier = container.read(appStateProvider.notifier);
      await notifier.startSearch();
      notifier.startJourney();
      final journey = container.read(appStateProvider).journey;

      notifier.setOrigin('新宿', latLng: const GeoPoint(35.69, 139.70));

      expect(container.read(appStateProvider).journey, same(journey));
    });
  });
}
