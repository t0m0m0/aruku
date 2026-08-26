import 'package:aruku/core/config/layout_breakpoints.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/error/error_screen.dart';
import 'package:aruku/features/settings/settings_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../e2e/support/e2e_helpers.dart';

const _content = Key('desktop-content');

void _setViewport(WidgetTester tester, double width) {
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<ProviderContainer> _pumpApp(WidgetTester tester, double width) async {
  _setViewport(tester, width);
  final container = await makeContainer();
  addTearDown(container.dispose);
  await tester.pumpWidget(appWidget(container));
  await pumpTransition(tester);
  return container;
}

class _ThrowingRouteService implements RouteService {
  const _ThrowingRouteService();

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
  }) async => throw const RouteException('HTTP 500');
}

Future<void> _pumpErrorScreen(
  WidgetTester tester, {
  required bool desktop,
}) async {
  _setViewport(tester, desktop ? 1280 : 800);
  final container = ProviderContainer(
    overrides: [
      routeServiceProvider.overrideWithValue(const _ThrowingRouteService()),
      isDesktopLayoutProvider.overrideWithValue(desktop),
    ],
  );
  addTearDown(container.dispose);
  await container.read(appStateProvider.notifier).startSearch();

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: ArukuTheme.light(),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: const ErrorScreen(),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('ホーム', () {
    testWidgets('デスクトップ幅では本文を 620px で頭打ちにする', (tester) async {
      await _pumpApp(tester, 1280);
      expect(tester.getSize(find.byKey(_content)).width, 620);
    });

    testWidgets('デスクトップ幅では本文を中央へ寄せる', (tester) async {
      await _pumpApp(tester, 1280);
      final box = tester.getRect(find.byKey(_content));
      expect(box.left, 1280 / 2 - 620 / 2);
    });

    testWidgets('モバイル幅では幅を制約しない', (tester) async {
      await _pumpApp(tester, 819);
      expect(find.byKey(_content), findsNothing);
    });
  });

  group('設定', () {
    Future<void> openSettings(WidgetTester tester) async {
      await tester.tap(find.byKey(const Key('shell-tab-settings')));
      await pumpTransition(tester);
    }

    testWidgets('デスクトップ幅では本文を 760px で頭打ちにする', (tester) async {
      await _pumpApp(tester, 1280);
      await openSettings(tester);
      expect(
        tester
            .getSize(
              find.descendant(
                of: find.byType(SettingsScreen),
                matching: find.byKey(_content),
              ),
            )
            .width,
        760,
      );
    });

    testWidgets('デスクトップ幅では見出しと中身を横並びにする', (tester) async {
      await _pumpApp(tester, 1280);
      await openSettings(tester);

      final title = tester.getRect(find.text('通知'));
      final row = tester.getRect(find.byKey(const Key('switch_notifications')));

      expect(title.left, lessThan(row.left));
      expect(title.top, closeTo(row.top, 24));
    });

    testWidgets('モバイル幅では見出しを中身の上に積む', (tester) async {
      final container = await _pumpApp(tester, 819);
      container.read(appStateProvider.notifier).go(Screen.settings);
      await pumpTransition(tester);

      final title = tester.getRect(find.text('通知'));
      final row = tester.getRect(find.byKey(const Key('switch_notifications')));

      expect(title.bottom, lessThanOrEqualTo(row.top));
    });
  });

  group('エラー', () {
    testWidgets('デスクトップ幅では本文を 520px で頭打ちにする', (tester) async {
      await _pumpErrorScreen(tester, desktop: true);
      expect(tester.getSize(find.byKey(_content)).width, 520);
    });

    testWidgets('モバイル幅では幅を制約しない', (tester) async {
      await _pumpErrorScreen(tester, desktop: false);
      expect(find.byKey(_content), findsNothing);
    });
  });
}
