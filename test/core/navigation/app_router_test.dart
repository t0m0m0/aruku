import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/navigation/app_router.dart';
import 'package:aruku/core/navigation/screen_paths.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/features/loading/loading_screen.dart';
import 'package:aruku/features/onboarding/onboarding_screen.dart';
import 'package:aruku/features/result/result_screen.dart';
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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('初期 location', () {
    testWidgets('オンボーディング未完了なら /onboarding から始まる', (tester) async {
      final container = await makeContainer(onboardingDone: false);
      addTearDown(container.dispose);

      await tester.pumpWidget(routerApp(container));
      await pumpTransition(tester);

      expect(find.byType(OnboardingScreen), findsOneWidget);
    });

    testWidgets('オンボーディング完了済みなら /home から始まる', (tester) async {
      final container = await makeContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(routerApp(container));
      await pumpTransition(tester);

      expect(find.byType(HomeScreen), findsOneWidget);
    });
  });

  group('実 Navigator スタックの back', () {
    testWidgets('settings からの back は home へ pop する', (tester) async {
      final container = await makeContainer();
      addTearDown(container.dispose);
      final router = container.read(goRouterProvider);

      await tester.pumpWidget(routerApp(container));
      await pumpTransition(tester);

      router.go('/home/settings');
      await pumpTransition(tester);
      expect(find.byType(SettingsScreen), findsOneWidget);

      await tester.binding.handlePopRoute();
      await pumpTransition(tester);
      expect(find.byType(HomeScreen), findsOneWidget);
    });

    testWidgets('home での back は何も起きない（アプリ終了しない）', (tester) async {
      final container = await makeContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(routerApp(container));
      await pumpTransition(tester);

      await tester.binding.handlePopRoute();
      await pumpTransition(tester);
      expect(find.byType(HomeScreen), findsOneWidget);
    });

    testWidgets('loading での back は何も起きない', (tester) async {
      final gate = Completer<void>();
      final container = await makeContainer(
        routeService: HoldingRouteService(gate),
      );
      addTearDown(container.dispose);
      addTearDown(gate.complete);
      final router = container.read(goRouterProvider);

      await tester.pumpWidget(routerApp(container));
      await pumpTransition(tester);

      // startSearch で routePhase が立つ（redirect ガードを通過できる状態）。
      unawaited(container.read(appStateProvider.notifier).startSearch());
      await tester.pump();
      router.go('/home/loading');
      await pumpTransition(tester);
      expect(find.byType(LoadingScreen), findsOneWidget);

      await tester.binding.handlePopRoute();
      await pumpTransition(tester);
      expect(find.byType(LoadingScreen), findsOneWidget);
    });
  });

  group('deep link ガード', () {
    testWidgets('route 未取得で /home/result へ入ると /home へ跳ね返す', (tester) async {
      final container = await makeContainer();
      addTearDown(container.dispose);
      final router = container.read(goRouterProvider);

      await tester.pumpWidget(routerApp(container));
      await pumpTransition(tester);

      router.go('/home/result');
      await pumpTransition(tester);

      expect(find.byType(ResultScreen), findsNothing);
      expect(find.byType(HomeScreen), findsOneWidget);
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        Screen.home.path,
      );
    });

    testWidgets('route 取得済みなら /home/result を表示できる', (tester) async {
      final container = await makeContainer(
        routeService: const FixedRouteService(testRoutePlan),
      );
      addTearDown(container.dispose);
      final router = container.read(goRouterProvider);

      await tester.pumpWidget(routerApp(container));
      await pumpTransition(tester);

      container
          .read(appStateProvider.notifier)
          .setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
      await container.read(appStateProvider.notifier).startSearch();
      await tester.pump();

      router.go('/home/result');
      await pumpTransition(tester);

      expect(find.byType(ResultScreen), findsOneWidget);
    });

    testWidgets('失効した isNow 経路への /home/result deep link は home へ跳ね返す', (
      tester,
    ) async {
      var clock = DateTime(2026, 7, 13, 9, 25);
      final container = await makeContainer(
        routeService: const FixedRouteService(testRoutePlan),
        now: () => clock,
      );
      addTearDown(container.dispose);
      final router = container.read(goRouterProvider);

      await tester.pumpWidget(routerApp(container));
      await pumpTransition(tester);

      container
          .read(appStateProvider.notifier)
          .setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
      await container.read(appStateProvider.notifier).startSearch();
      await tester.pump();

      // 経路確定から猶予（5分）超過。以後 result/nav は失効扱いで弾かれる。
      clock = DateTime(2026, 7, 13, 9, 31);
      router.go('/home/result');
      await pumpTransition(tester);

      expect(find.byType(ResultScreen), findsNothing);
      expect(find.byType(HomeScreen), findsOneWidget);
    });
  });
}
