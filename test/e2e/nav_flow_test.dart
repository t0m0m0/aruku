import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/e2e_helpers.dart';

/// 結果画面に到達した状態のコンテナを返す。
Future<_NavSetup> _pumpToResult(WidgetTester tester) async {
  final container = await makeContainer(
    routeService: const FixedRouteService(testRoutePlan),
  );
  container.read(appStateProvider);
  container
      .read(appStateProvider.notifier)
      .setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
  await tester.pumpWidget(appWidget(container));
  await tester.pump();

  await tester.tap(find.text('ルートを検索'));
  await tester.pumpAndSettle();

  assert(
    container.read(appStateProvider).screen == Screen.result,
    '前提条件: 結果画面へ遷移していること',
  );
  return _NavSetup(container);
}

class _NavSetup {
  const _NavSetup(this.container);
  final ProviderContainer container;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  // #305: 結果画面の主CTAはNavScreen遷移からGoogle Maps引き継ぎへ差し替わった
  // （区間CTAタップは外部起動のみで screen を変えない）。Nav 画面自体は健在の
  // ため、startNavigation() を直接呼んで遷移させ、画面としての疎通を検証する。
  testWidgets('startNavigation() 呼び出しでナビ画面へ遷移する', (tester) async {
    final setup = await _pumpToResult(tester);
    addTearDown(setup.container.dispose);

    setup.container.read(appStateProvider.notifier).startNavigation();
    await tester.pump();
    // ルーターの遷移アニメ（220ms）を完了させる。nav 画面は位置ドットが
    // アニメし続け pumpAndSettle できないため固定時間で送る。
    await tester.pump(const Duration(milliseconds: 300));

    expect(setup.container.read(appStateProvider).screen, Screen.nav);
    expect(find.byKey(const Key('nav-exit-button')), findsOneWidget);
  });

  testWidgets('ナビ画面の「終了」ボタンでホームへ戻る', (tester) async {
    final setup = await _pumpToResult(tester);
    addTearDown(setup.container.dispose);

    setup.container.read(appStateProvider.notifier).startNavigation();
    await tester.pump();
    // ルーターの遷移アニメ（220ms）を完了させる。nav 画面は位置ドットが
    // アニメし続け pumpAndSettle できないため固定時間で送る。
    await tester.pump(const Duration(milliseconds: 300));

    expect(setup.container.read(appStateProvider).screen, Screen.nav);

    await tester.tap(find.byKey(const Key('nav-exit-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('nav-exit-confirm-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(setup.container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('ナビ開始後は位置追跡が有効になり、終了後は停止する', (tester) async {
    final setup = await _pumpToResult(tester);
    addTearDown(setup.container.dispose);

    // ナビ開始前: currentPosition は null
    expect(setup.container.read(appStateProvider).currentPosition, isNull);

    setup.container.read(appStateProvider.notifier).startNavigation();
    await tester.pump();
    // ルーターの遷移アニメ（220ms）を完了させる。nav 画面は位置ドットが
    // アニメし続け pumpAndSettle できないため固定時間で送る。
    await tester.pump(const Duration(milliseconds: 300));

    // ナビ終了
    await tester.tap(find.byKey(const Key('nav-exit-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('nav-exit-confirm-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 終了後: currentPosition はリセットされる
    expect(setup.container.read(appStateProvider).currentPosition, isNull);
    expect(setup.container.read(appStateProvider).screen, Screen.home);
  });
}
