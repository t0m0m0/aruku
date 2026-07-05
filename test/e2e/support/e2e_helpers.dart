import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/navigation/app_router.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// ルーターの遷移アニメ（[kRouteTransitionDuration]）を完了させる。
/// loading / nav 画面は無限アニメで pumpAndSettle できないため固定時間で送る。
/// 時間はソースの定数を参照するため、値を変えてもテストが自動追従する。
Future<void> pumpTransition(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(kRouteTransitionDuration);
}

/// 応答を外部から解放できるルートサービス。loading 状態の維持や、
/// ローディング中の画面確認に使う。
class HoldingRouteService implements RouteService {
  HoldingRouteService(this.gate);

  final Completer<void> gate;

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
    await gate.future;
    return testRoutePlan;
  }
}

class FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class FakeActivityService implements ActivityService {
  @override
  Future<bool> requestPermission() async => false;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => const Stream.empty();
}

class FixedRouteService implements RouteService {
  const FixedRouteService(this._plan);

  final RoutePlan _plan;

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

class FailingRouteService implements RouteService {
  const FailingRouteService(this._error);

  final Object _error;

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
    // Duration.zero にすることでタイマー経由の非同期になり、
    // pump()（タイマーを進めない）中に loading 状態を観測できる。
    await Future<void>.delayed(Duration.zero);
    throw _error;
  }
}

/// 本番と同じ goRouterProvider でアプリ全体を組み立てる。
/// TestRoot（switch の複製）は廃止し、実 Navigator スタックで検証する。
Widget appWidget(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp.router(
    theme: ArukuTheme.light(),
    routerConfig: container.read(goRouterProvider),
  ),
);

/// 共通のプロバイダオーバーライドでコンテナを生成する。
///
/// [onboardingDone] でオンボーディング完了状態を制御する。
/// [routeService] / [locationService] が指定された場合は該当プロバイダを
/// 差し替える（位置ストリームを外部制御したいテスト向け）。
Future<ProviderContainer> makeContainer({
  bool onboardingDone = true,
  RouteService? routeService,
  LocationService? locationService,
}) async {
  final prefs = await SharedPreferences.getInstance();
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWith((ref) => prefs),
      onboardingCompletedProvider.overrideWithValue(onboardingDone),
      locationServiceProvider.overrideWithValue(
        locationService ?? FakeLocationService(),
      ),
      activityServiceProvider.overrideWithValue(FakeActivityService()),
      if (routeService != null)
        routeServiceProvider.overrideWithValue(routeService),
    ],
  );
}

const testRoutePlan = RoutePlan(
  from: '現在地',
  to: '渋谷駅',
  totalKm: 4.2,
  totalMin: 52,
  budgetMin: 60,
  kcal: 187,
  walkKm: 3.8,
  walkRatio: 0.90,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: '現在地',
      toName: '渋谷駅',
      km: 3.8,
      minutes: 49,
      kcal: 187,
      polyline: [GeoPoint(35.6685, 139.7024), GeoPoint(35.6580, 139.7016)],
    ),
  ],
  timelineNodes: [
    TimelineNode(time: '9:00', place: '現在地', sub: '出発'),
    TimelineNode(time: '9:52', place: '渋谷駅', sub: '到着 · 制限内 ✓'),
  ],
);
