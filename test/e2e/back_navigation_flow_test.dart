import 'dart:async';
import 'dart:io';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/e2e_helpers.dart';

/// 旧 main.dart の PopScope 手動分岐と同じ back 挙動を、実 Navigator の
/// pop で再現できていることを検証する（go_router 移行の parity テスト）。
///
/// 旧分岐: auth→settings / settings・search・searchOrigin・result・nav・
/// error→home / home・onboarding・loading→無反応。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<void> pumpTransition(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  Future<void> back(WidgetTester tester) async {
    await tester.binding.handlePopRoute();
    await pumpTransition(tester);
  }

  Future<ProviderContainer> pumpApp(
    WidgetTester tester, {
    bool onboardingDone = true,
    RouteService? routeService,
  }) async {
    final container = await makeContainer(
      onboardingDone: onboardingDone,
      routeService: routeService,
    );
    addTearDown(container.dispose);
    container.read(appStateProvider);
    await tester.pumpWidget(appWidget(container));
    await pumpTransition(tester);
    return container;
  }

  Screen screenOf(ProviderContainer c) => c.read(appStateProvider).screen;

  testWidgets('settings からの back は home へ戻る', (tester) async {
    final container = await pumpApp(tester);
    container.read(appStateProvider.notifier).go(Screen.settings);
    await pumpTransition(tester);

    await back(tester);
    expect(screenOf(container), Screen.home);
  });

  testWidgets('auth からの back は settings へ戻る（home まで飛ばない）', (tester) async {
    final container = await pumpApp(tester);
    container.read(appStateProvider.notifier).go(Screen.auth);
    await pumpTransition(tester);

    await back(tester);
    expect(screenOf(container), Screen.settings);

    await back(tester);
    expect(screenOf(container), Screen.home);
  });

  testWidgets('search / searchOrigin からの back は home へ戻る', (tester) async {
    final container = await pumpApp(tester);
    final notifier = container.read(appStateProvider.notifier);

    notifier.go(Screen.search);
    await pumpTransition(tester);
    await back(tester);
    expect(screenOf(container), Screen.home);

    notifier.go(Screen.searchOrigin);
    await pumpTransition(tester);
    await back(tester);
    expect(screenOf(container), Screen.home);
  });

  testWidgets('result / nav からの back は home へ戻る', (tester) async {
    final container = await pumpApp(
      tester,
      routeService: const FixedRouteService(testRoutePlan),
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    await notifier.startSearch();
    await pumpTransition(tester);
    expect(screenOf(container), Screen.result);

    await back(tester);
    expect(screenOf(container), Screen.home);

    // nav へ（result 経由で route は保持されている）。
    notifier.go(Screen.nav);
    await pumpTransition(tester);
    expect(screenOf(container), Screen.nav);

    await back(tester);
    expect(screenOf(container), Screen.home);
  });

  testWidgets('error からの back は home へ戻る', (tester) async {
    final container = await pumpApp(
      tester,
      routeService: const FailingRouteService(
        SocketException('network unreachable'),
      ),
    );
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    // FailingRouteService は Duration.zero のタイマーで失敗するため、本体で
    // await するとタイマーが進まずデッドロックする。tester にタイマーを
    // 進めさせるため fire-and-forget + pumpAndSettle にする。
    unawaited(notifier.startSearch());
    await tester.pumpAndSettle();
    expect(screenOf(container), Screen.error);

    await back(tester);
    expect(screenOf(container), Screen.home);
  });

  testWidgets('home での back は無反応（アプリ終了しない）', (tester) async {
    final container = await pumpApp(tester);

    await back(tester);
    expect(screenOf(container), Screen.home);
  });

  testWidgets('onboarding での back は無反応', (tester) async {
    final container = await pumpApp(tester, onboardingDone: false);

    await back(tester);
    expect(screenOf(container), Screen.onboarding);
  });

  testWidgets('loading での back は無反応', (tester) async {
    final gate = Completer<void>();
    final container = await pumpApp(
      tester,
      routeService: _HoldingRouteService(gate),
    );
    addTearDown(gate.complete);
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    unawaited(notifier.startSearch());
    await pumpTransition(tester);
    expect(screenOf(container), Screen.loading);

    await back(tester);
    expect(screenOf(container), Screen.loading);
  });
}

class _HoldingRouteService implements RouteService {
  _HoldingRouteService(this._gate);

  final Completer<void> _gate;

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
    await _gate.future;
    return testRoutePlan;
  }
}
