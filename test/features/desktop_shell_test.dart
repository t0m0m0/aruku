import 'dart:async';

import 'package:aruku/core/navigation/app_router.dart';
import 'package:aruku/core/navigation/screen_paths.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../e2e/support/e2e_helpers.dart';

/// ビューポート幅を [width] に固定してアプリを起動する。
Future<void> _pumpAppAt(WidgetTester tester, double width) async {
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final container = await makeContainer();
  addTearDown(container.dispose);
  await tester.pumpWidget(appWidget(container));
  await pumpTransition(tester);
}

const _planTab = Key('shell-tab-plan');
const _settingsTab = Key('shell-tab-settings');

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('820px 以上では上部バーとタブが出る', (tester) async {
    await _pumpAppAt(tester, 1280);

    expect(find.byKey(const Key('desktop-shell-top-bar')), findsOneWidget);
    expect(find.byKey(_planTab), findsOneWidget);
    expect(find.byKey(_settingsTab), findsOneWidget);
  });

  // 上部バーはデスクトップだけの導線。ここが崩れると iOS / Android の画面に
  // 本来無いバーが載るため、モバイル側は「出ない」ことを固定する。
  testWidgets('819px では上部バーが出ない', (tester) async {
    await _pumpAppAt(tester, 819);

    expect(find.byKey(const Key('desktop-shell-top-bar')), findsNothing);
    expect(find.byKey(_planTab), findsNothing);
    expect(find.byKey(_settingsTab), findsNothing);
  });

  testWidgets('設定タブで設定画面へ移り、router の location も追従する', (tester) async {
    await _pumpAppAt(tester, 1280);
    final container = ProviderScope.containerOf(
      tester.element(find.byKey(_settingsTab)),
    );

    await tester.tap(find.byKey(_settingsTab));
    await pumpTransition(tester);

    expect(container.read(appStateProvider).screen, Screen.settings);
    expect(
      container
          .read(goRouterProvider)
          .routerDelegate
          .currentConfiguration
          .uri
          .path,
      Screen.settings.path,
    );
  });

  testWidgets('計画タブでホームへ戻る', (tester) async {
    await _pumpAppAt(tester, 1280);
    final container = ProviderScope.containerOf(
      tester.element(find.byKey(_settingsTab)),
    );

    await tester.tap(find.byKey(_settingsTab));
    await pumpTransition(tester);
    await tester.tap(find.byKey(_planTab));
    await pumpTransition(tester);

    expect(container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('現在の画面に対応するタブが選択状態になる', (tester) async {
    await _pumpAppAt(tester, 1280);

    Set<Key> selected() => tester
        .widgetList<Semantics>(
          find.descendant(
            of: find.byKey(const Key('desktop-shell-top-bar')),
            matching: find.byType(Semantics),
          ),
        )
        .where((s) => s.properties.selected ?? false)
        .map((s) => s.key)
        .whereType<Key>()
        .toSet();

    expect(selected(), contains(const Key('shell-tab-plan-semantics')));

    await tester.tap(find.byKey(_settingsTab));
    await pumpTransition(tester);

    expect(selected(), contains(const Key('shell-tab-settings-semantics')));
    expect(selected(), isNot(contains(const Key('shell-tab-plan-semantics'))));
  });

  group('ローディング中の離脱', () {
    Future<ProviderContainer> pumpLoading(WidgetTester tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final container = await makeContainer(
        routeService: HoldingRouteService(Completer<void>()),
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(appWidget(container));
      await pumpTransition(tester);

      container.read(appStateProvider.notifier).setDestination('渋谷駅');
      unawaited(container.read(appStateProvider.notifier).startSearch());
      await pumpTransition(tester);
      expect(container.read(appStateProvider).screen, Screen.loading);
      return container;
    }

    // screen だけ変えても探索は走り続け、完了時に result / error へ引き戻す。
    // 画面と表示前提データ（routePhase）は必ず一緒に更新する。
    testWidgets('設定タブへ移るとき進行中の探索を打ち切る', (tester) async {
      final container = await pumpLoading(tester);

      await tester.tap(find.byKey(_settingsTab));
      await pumpTransition(tester);

      final state = container.read(appStateProvider);
      expect(state.screen, Screen.settings);
      expect(state.routePhase, isNull);
    });

    testWidgets('計画タブへ移るとき進行中の探索を打ち切る', (tester) async {
      final container = await pumpLoading(tester);

      await tester.tap(find.byKey(_planTab));
      await pumpTransition(tester);

      final state = container.read(appStateProvider);
      expect(state.screen, Screen.home);
      expect(state.routePhase, isNull);
    });
  });

  // 画面遷移のたびにバーが作り直されると、デザインが要求する「スクロールしない
  // 固定バー」が遷移アニメに巻き込まれる。永続していることを実体数で固定する。
  testWidgets('画面遷移をまたいで上部バーは1つのまま', (tester) async {
    await _pumpAppAt(tester, 1280);

    await tester.tap(find.byKey(_settingsTab));
    await pumpTransition(tester);

    expect(find.byKey(const Key('desktop-shell-top-bar')), findsOneWidget);
  });
}
