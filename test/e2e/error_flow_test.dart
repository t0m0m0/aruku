import 'dart:io';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/e2e_helpers.dart';

/// 目的地設定済みのホーム画面を表示し、「ルートを検索」タップ後に
/// [routeService] が投げるエラーによってエラー画面に到達するまで待つ。
Future<void> _searchAndExpectError(
  WidgetTester tester,
  FailingRouteService routeService,
) async {
  final container = await makeContainer(routeService: routeService);
  addTearDown(container.dispose);

  container.read(appStateProvider);
  container
      .read(appStateProvider.notifier)
      .setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
  await tester.pumpWidget(appWidget(container));
  await tester.pump();

  await tester.tap(find.text('ルートを検索'));
  await tester.pumpAndSettle();

  expect(container.read(appStateProvider).screen, Screen.error);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('ルート検索でネットワークエラーが起きるとエラー画面が表示される', (tester) async {
    await _searchAndExpectError(
      tester,
      const FailingRouteService(SocketException('network unreachable')),
    );

    expect(find.text('通信に失敗しました'), findsOneWidget);
  });

  testWidgets('ネットワークエラーでは「再試行」が主アクション', (tester) async {
    await _searchAndExpectError(
      tester,
      const FailingRouteService(SocketException('timeout')),
    );

    // primary ボタンが「再試行」（ArukuButton の第一候補）
    expect(find.text('再試行'), findsOneWidget);
    expect(find.text('検索に戻る'), findsOneWidget);
  });

  testWidgets('noResults エラーでは「ルートが見つかりませんでした」が表示される', (tester) async {
    await _searchAndExpectError(
      tester,
      const FailingRouteService(RouteException('ZERO_RESULTS')),
    );

    expect(find.text('ルートが見つかりませんでした'), findsOneWidget);
  });

  testWidgets('noResults エラーでは「条件を変更」が主アクション', (tester) async {
    await _searchAndExpectError(
      tester,
      const FailingRouteService(RouteException('ZERO_RESULTS')),
    );

    expect(find.text('条件を変更'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
  });

  testWidgets('エラー画面の「条件を変更」タップでホームへ遷移する', (tester) async {
    final container = await makeContainer(
      routeService: const FailingRouteService(RouteException('ZERO_RESULTS')),
    );
    addTearDown(container.dispose);

    container.read(appStateProvider);
    container
        .read(appStateProvider.notifier)
        .setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    await tester.tap(find.text('ルートを検索'));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.error);

    await tester.tap(find.text('条件を変更'));
    await tester.pump();

    expect(container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('エラー画面の「再試行」タップで再度ローディングへ遷移する', (tester) async {
    // network エラーの場合、primary は「再試行」
    final container = await makeContainer(
      routeService: const FailingRouteService(SocketException('fail')),
    );
    addTearDown(container.dispose);

    container.read(appStateProvider);
    container
        .read(appStateProvider.notifier)
        .setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    await tester.tap(find.text('ルートを検索'));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.error);

    // 再試行タップ → 再度 startSearch() → loading → error（サービスはまだ失敗）
    await tester.tap(find.text('再試行'));
    await tester.pump(); // loading 状態になる

    expect(container.read(appStateProvider).screen, Screen.loading);
  });
}
