import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/analytics_service.dart';
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

class _StubRouteService implements RouteService {
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

class _RecordingAnalyticsService implements AnalyticsService {
  int searchRequestedCount = 0;

  @override
  void logSearchRequested() {
    searchRequestedCount++;
  }

  @override
  void logSearchFallbackTriggered({
    required int navitimeCalls,
    required int googleWalkCalls,
    required int googleMatrixCalls,
  }) {}

  @override
  void logSearchApiCalls({
    required int navitimeCalls,
    required int googleWalkCalls,
    required int googleMatrixCalls,
    required bool fallbackTriggered,
  }) {}
}

void main() {
  test('startSearch は開始時に search_requested を1回記録する', () async {
    final analytics = _RecordingAnalyticsService();
    final container = ProviderContainer(
      overrides: [
        routeServiceProvider.overrideWithValue(_StubRouteService()),
        analyticsServiceProvider.overrideWithValue(analytics),
      ],
    );
    addTearDown(container.dispose);

    await container.read(appStateProvider.notifier).startSearch();

    expect(analytics.searchRequestedCount, 1);
  });
}
