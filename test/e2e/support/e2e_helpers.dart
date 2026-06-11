import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/auth/auth_screen.dart';
import 'package:aruku/features/error/error_screen.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/features/loading/loading_screen.dart';
import 'package:aruku/features/navigation/nav_screen.dart';
import 'package:aruku/features/onboarding/onboarding_screen.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/features/search/search_screen.dart';
import 'package:aruku/features/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

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
  }) async => throw _error;
}

/// アプリ全体のルーティングを再現するテスト用ルートウィジェット。
/// main.dart の _Root と同等だが、アニメーションを省いてテストを高速化する。
class TestRoot extends ConsumerWidget {
  const TestRoot({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return switch (ref.watch(appStateProvider).screen) {
      Screen.onboarding => const OnboardingScreen(),
      Screen.home => const HomeScreen(),
      Screen.settings => const SettingsScreen(),
      Screen.auth => const AuthScreen(),
      Screen.search => const SearchScreen(),
      Screen.searchOrigin => const SearchScreen(mode: SearchMode.origin),
      Screen.loading => const LoadingScreen(),
      Screen.result => const ResultScreen(),
      Screen.nav => const NavScreen(),
      Screen.error => const ErrorScreen(),
    };
  }
}

Widget appWidget(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(theme: ArukuTheme.light(), home: const TestRoot()),
);

/// 共通のプロバイダオーバーライドでコンテナを生成する。
///
/// [onboardingDone] でオンボーディング完了状態を制御する。
/// [routeService] が指定された場合は [routeServiceProvider] を差し替える。
Future<ProviderContainer> makeContainer({
  bool onboardingDone = true,
  RouteService? routeService,
}) async {
  final prefs = await SharedPreferences.getInstance();
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWith((ref) => prefs),
      onboardingCompletedProvider.overrideWithValue(onboardingDone),
      locationServiceProvider.overrideWithValue(FakeLocationService()),
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
