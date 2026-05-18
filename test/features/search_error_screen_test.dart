import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/error/error_screen.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _ThrowingRouteService implements RouteService {
  _ThrowingRouteService(this.status);
  final String status;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    void Function(RoutePhase)? onProgress,
  }) async => throw RouteException(status);
}

Widget _wrap(ProviderContainer container, Widget child) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(theme: ArukuTheme.light(), home: child),
    );

ProviderContainer _erroredContainer(String status) {
  final container = ProviderContainer(
    overrides: [
      routeServiceProvider.overrideWithValue(_ThrowingRouteService(status)),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  testWidgets('通信失敗は network 文言と主導線「再試行」を表示する', (tester) async {
    final container = _erroredContainer('HTTP 500');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container, const ErrorScreen()));

    expect(find.text('通信に失敗しました'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
    expect(find.text('検索に戻る'), findsOneWidget);

    await tester.tap(find.text('検索に戻る'));
    await tester.pump();
    expect(container.read(appStateProvider).screen, Screen.search);
  });

  testWidgets('候補なしは noResults 文言と主導線「条件を変更」を表示する', (tester) async {
    final container = _erroredContainer('ZERO_RESULTS');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container, const ErrorScreen()));

    expect(find.text('ルートが見つかりませんでした'), findsOneWidget);
    expect(find.text('条件を変更'), findsOneWidget);

    await tester.tap(find.text('条件を変更'));
    await tester.pump();
    expect(container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('現在地取得失敗は noLocation 文言を表示する', (tester) async {
    final container = _erroredContainer('NO_ORIGIN');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container, const ErrorScreen()));

    expect(find.text('現在地を取得できませんでした'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
  });

  testWidgets('ResultScreen は route が null のとき復帰導線を出す', (tester) async {
    final container = ProviderContainer();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const ResultScreen()));
    await tester.pump();

    expect(container.read(appStateProvider).route, isNull);
    expect(find.text('検索に戻る'), findsOneWidget);

    await tester.tap(find.text('検索に戻る'));
    await tester.pump();
    expect(container.read(appStateProvider).screen, Screen.search);
  });
}
