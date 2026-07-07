import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/navigation/app_router.dart';
import 'package:aruku/core/navigation/screen_paths.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/settings/settings_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../e2e/support/e2e_helpers.dart';

Widget routerApp(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp.router(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    routerConfig: container.read(goRouterProvider),
  ),
);

/// 位置ストリームを外部から流せるフェイク。
class _StreamLocationService implements LocationService {
  final controller = StreamController<GeoPoint>.broadcast();

  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => controller.stream;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('notifier.go() が router の location に反映される', (tester) async {
    final container = await makeContainer();
    addTearDown(container.dispose);
    final router = container.read(goRouterProvider);

    await tester.pumpWidget(routerApp(container));
    await pumpTransition(tester);

    container.read(appStateProvider.notifier).go(Screen.settings);
    await pumpTransition(tester);

    expect(
      router.routerDelegate.currentConfiguration.uri.path,
      Screen.settings.path,
    );
    expect(find.byType(SettingsScreen), findsOneWidget);
  });

  testWidgets('システム back の pop が state.screen へ書き戻される', (tester) async {
    final container = await makeContainer();
    addTearDown(container.dispose);
    container.read(goRouterProvider);

    await tester.pumpWidget(routerApp(container));
    await pumpTransition(tester);

    container.read(appStateProvider.notifier).go(Screen.settings);
    await pumpTransition(tester);
    expect(container.read(appStateProvider).screen, Screen.settings);

    await tester.binding.handlePopRoute();
    await pumpTransition(tester);

    expect(container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('nav 中のシステム back で GPS 追跡が停止する', (tester) async {
    final location = _StreamLocationService();
    addTearDown(location.controller.close);
    final container = await makeContainer(
      routeService: const FixedRouteService(testRoutePlan),
      locationService: location,
    );
    addTearDown(container.dispose);
    container.read(goRouterProvider);

    await tester.pumpWidget(routerApp(container));
    await pumpTransition(tester);

    // route を確定させてから nav へ（redirect ガード通過）。
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    await notifier.startSearch();
    await pumpTransition(tester);
    notifier.go(Screen.nav);
    await pumpTransition(tester);

    // 経路上の点を流す → 追跡中なので currentPosition に反映される。
    location.controller.add(const GeoPoint(35.6685, 139.7024));
    await tester.pump();
    expect(container.read(appStateProvider).currentPosition, isNotNull);

    // 実 pop で home へ戻る → 確認ダイアログで終了を選ぶと書き戻し経由で
    // 追跡が停止・位置がクリアされる。
    await tester.binding.handlePopRoute();
    await pumpTransition(tester);
    await tester.tap(find.byKey(const Key('nav-exit-confirm-button')));
    await pumpTransition(tester);

    expect(container.read(appStateProvider).screen, Screen.home);
    expect(container.read(appStateProvider).currentPosition, isNull);

    // 停止後に位置が流れても反映されない（購読解除の確認）。
    location.controller.add(const GeoPoint(35.6580, 139.7016));
    await tester.pump();
    expect(container.read(appStateProvider).currentPosition, isNull);
  });

  testWidgets('nav への deep link（router 経由）でも GPS 追跡が開始する', (tester) async {
    // go() 経由ではなく router.go（＝deep link と同じ経路）で nav へ入っても、
    // routerDelegate リスナ→syncScreen→_startTracking が発火することを確認する。
    final location = _StreamLocationService();
    addTearDown(location.controller.close);
    final container = await makeContainer(
      routeService: const FixedRouteService(testRoutePlan),
      locationService: location,
    );
    addTearDown(container.dispose);
    final router = container.read(goRouterProvider);

    await tester.pumpWidget(routerApp(container));
    await pumpTransition(tester);

    // route を確定（redirect ガード通過の前提）。go() は使わない。
    final notifier = container.read(appStateProvider.notifier);
    notifier.setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    await notifier.startSearch();
    await pumpTransition(tester);

    // router から直接 /home/nav へ（アプリ内 go() を経由しない）。
    router.go(Screen.nav.path);
    await pumpTransition(tester);
    expect(container.read(appStateProvider).screen, Screen.nav);

    // 追跡が開始しているので現在地が反映される。
    location.controller.add(const GeoPoint(35.6685, 139.7024));
    await tester.pump();
    expect(container.read(appStateProvider).currentPosition, isNotNull);
  });

  testWidgets('同期がエコーで発散しない', (tester) async {
    final container = await makeContainer();
    addTearDown(container.dispose);
    final router = container.read(goRouterProvider);

    await tester.pumpWidget(routerApp(container));
    await pumpTransition(tester);

    var notifications = 0;
    router.routerDelegate.addListener(() => notifications++);

    container.read(appStateProvider.notifier).go(Screen.settings);
    await pumpTransition(tester);
    await pumpTransition(tester);

    // 1 回の遷移で delegate 通知が有限回に収まり、状態が安定していること。
    expect(notifications, lessThan(5));
    expect(container.read(appStateProvider).screen, Screen.settings);
    expect(
      router.routerDelegate.currentConfiguration.uri.path,
      Screen.settings.path,
    );
  });

  testWidgets('deep link の跳ね返りが state.screen を自己修復する', (tester) async {
    final container = await makeContainer();
    addTearDown(container.dispose);
    final router = container.read(goRouterProvider);

    await tester.pumpWidget(routerApp(container));
    await pumpTransition(tester);

    // route なしで result へ deep link → redirect が home へ戻し、
    // state.screen も home のまま（result で固まらない）。
    router.go(Screen.result.path);
    await pumpTransition(tester);

    expect(container.read(appStateProvider).screen, Screen.home);
    expect(
      router.routerDelegate.currentConfiguration.uri.path,
      Screen.home.path,
    );
  });
}
