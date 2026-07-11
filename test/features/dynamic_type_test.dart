import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/features/onboarding/onboarding_screen.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:aruku/shared/widgets/aruku_button.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _FakeActivityService implements ActivityService {
  @override
  Future<bool> requestPermission() async => false;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => const Stream.empty();
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

const _plan = RoutePlan(
  from: '現在地',
  to: '渋谷駅',
  totalKm: 4.2,
  totalMin: 52,
  budgetMin: 60,
  kcal: 187,
  walkKm: 3.8,
  walkRatio: 0.9,
  segments: [],
  timelineNodes: [
    TimelineNode(time: '9:00', place: '現在地', sub: '出発'),
    TimelineNode(time: '9:52', place: '渋谷駅', sub: '到着'),
  ],
);

/// 乗換の多い長いタイムラインを持つプラン（カード高を超える想定）。
RoutePlan _longPlan() => RoutePlan(
  from: '現在地',
  to: '渋谷駅',
  totalKm: 4.2,
  totalMin: 52,
  budgetMin: 60,
  kcal: 187,
  walkKm: 3.8,
  walkRatio: 0.9,
  segments: const [],
  timelineNodes: List.generate(
    24,
    (i) => TimelineNode(
      time: '9:${i.toString().padLeft(2, '0')}',
      place: '地点$i',
      sub: '経由',
    ),
  ),
);

/// 端末の最大文字拡大に近い倍率で画面をラップする。
Widget _scaled(ProviderContainer container, Widget child, double scale) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: ArukuTheme.light(),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: child,
        builder: (context, w) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: w!,
        ),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  // iPhone 相当の狭い画面 × 端末最大級の文字倍率（iOS AX 最大相当）で
  // オーバーフローしないこと。
  const scale = 3.0;

  testWidgets('ホームは最大文字拡大でレイアウトが崩れない', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final repo = ActivityLogRepository(await SharedPreferences.getInstance());
    final container = ProviderContainer(
      overrides: [
        activityServiceProvider.overrideWithValue(_FakeActivityService()),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        activityLogRepositoryProvider.overrideWith((ref) async => repo),
      ],
    );
    addTearDown(container.dispose);
    container.read(appStateProvider);

    await tester.pumpWidget(_scaled(container, const HomeScreen(), scale));
    await tester.pump();

    expect(tester.takeException(), isNull);
  });

  testWidgets('結果画面は最大文字拡大でレイアウトが崩れない', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final container = ProviderContainer(
      overrides: [
        routeServiceProvider.overrideWithValue(_FixedRouteService(_plan)),
      ],
    );
    addTearDown(container.dispose);
    await container.read(appStateProvider.notifier).startSearch();

    await tester.pumpWidget(_scaled(container, const ResultScreen(), scale));
    await tester.pump();

    expect(tester.takeException(), isNull);
  });

  testWidgets('オンボーディングは最大文字拡大でレイアウトが崩れない', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final container = ProviderContainer();
    addTearDown(container.dispose);

    await tester.pumpWidget(
      _scaled(container, const OnboardingScreen(), scale),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
  });

  testWidgets('結果画面は長いタイムラインでも歩くCTAが画面内に残る', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final container = ProviderContainer(
      overrides: [
        routeServiceProvider.overrideWithValue(_FixedRouteService(_longPlan())),
      ],
    );
    addTearDown(container.dispose);
    await container.read(appStateProvider.notifier).startSearch();

    // 通常サイズでも長い経路ではカードを溢れるが、主要導線の「歩く」CTA は
    // タイムラインの内側スクロールに退避させ、常に画面内に留める。
    await tester.pumpWidget(_scaled(container, const ResultScreen(), 1.0));
    await tester.pump();

    final ctaTop = tester.getTopLeft(find.byType(ArukuButton)).dy;
    final screenHeight = tester.view.physicalSize.height / 3.0;
    expect(ctaTop, lessThan(screenHeight));
  });
}
