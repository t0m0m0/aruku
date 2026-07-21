import 'package:aruku/core/navigation/app_router.dart';
import 'package:aruku/core/navigation/screen_paths.dart';
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
