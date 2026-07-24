import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/e2e_helpers.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('目的地が未設定のとき「目的地を選ぶ」ボタンが表示される', (tester) async {
    final container = await makeContainer();
    addTearDown(container.dispose);

    container.read(appStateProvider);
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    expect(find.text('目的地を選ぶ'), findsOneWidget);
    expect(find.text('ルートを検索'), findsNothing);
  });

  testWidgets('目的地を設定すると「ルートを検索」ボタンに切り替わる', (tester) async {
    final container = await makeContainer();
    addTearDown(container.dispose);

    container.read(appStateProvider);
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    container
        .read(appStateProvider.notifier)
        .setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    await tester.pump();

    expect(find.text('目的地を選ぶ'), findsNothing);
    expect(find.text('ルートを検索'), findsOneWidget);
  });

  testWidgets('「ルートを検索」タップでローディング画面へ遷移する', (tester) async {
    // ルートサービスを一時停止させてローディング状態を確認する
    final completer = Completer<void>();
    final container = await makeContainer(
      routeService: _HoldingRouteService(completer),
    );
    addTearDown(container.dispose);
    addTearDown(completer.complete); // テスト終了時に解放

    container.read(appStateProvider);
    container
        .read(appStateProvider.notifier)
        .setDestination('渋谷駅', latLng: const GeoPoint(35.658, 139.702));
    await tester.pumpWidget(appWidget(container));
    await tester.pump();

    await tester.tap(find.text('ルートを検索'));
    await tester.pump();
    // ルーターの遷移アニメ（220ms）を完了させ loading 画面を可視化する。
    // スピナーが回り続けるため pumpAndSettle は使えず固定時間で送る。
    await tester.pump(const Duration(milliseconds: 300));

    expect(container.read(appStateProvider).screen, Screen.loading);
    expect(find.text('歩ける道を、探しています'), findsOneWidget);
  });

  testWidgets('ルート計算完了後に結果画面へ遷移する', (tester) async {
    final container = await makeContainer(
      routeService: const FixedRouteService(testRoutePlan),
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

    expect(container.read(appStateProvider).screen, Screen.result);
    expect(container.read(appStateProvider).route, isNotNull);
    // #305: 主CTAはNavScreen遷移からGoogle Maps引き継ぎへ差し替わった。
    // testRoutePlan の唯一の区間は徒歩・渋谷駅行き。
    expect(find.text('Googleマップで徒歩ルートを開く'), findsOneWidget);
  });

  testWidgets('結果画面で目的地名が表示される', (tester) async {
    final container = await makeContainer(
      routeService: const FixedRouteService(testRoutePlan),
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

    // タイムラインの到着地点（testRoutePlan の toName）が画面に現れる
    expect(find.textContaining('渋谷駅'), findsWidgets);
  });

  testWidgets('結果画面から設定画面へ遷移せずホームへ戻れる', (tester) async {
    final container = await makeContainer(
      routeService: const FixedRouteService(testRoutePlan),
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

    expect(container.read(appStateProvider).screen, Screen.result);

    container.read(appStateProvider.notifier).go(Screen.home);
    await tester.pump();

    expect(container.read(appStateProvider).screen, Screen.home);
    expect(find.text('ルートを検索'), findsOneWidget);
    // 戻っても目的地は保持されている
    expect(container.read(appStateProvider).destination, '渋谷駅');
  });
}

/// ルートサービスの応答を外部から制御できるスタブ。
/// ローディング中の画面確認に使う。
class _HoldingRouteService extends FixedRouteService {
  _HoldingRouteService(this._gate) : super(testRoutePlan);

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
    CancellationToken? cancellation,
  }) async {
    await _gate.future;
    return super.plan(
      destination: destination,
      destinationLatLng: destinationLatLng,
      departure: departure,
      arrival: arrival,
      origin: origin,
      originName: originName,
      onProgress: onProgress,
      cancellation: cancellation,
    );
  }
}
