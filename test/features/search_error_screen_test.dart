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
  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
  }) async => throw const RouteException('NETWORK');
}

Widget _wrap(ProviderContainer container, Widget child) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(theme: ArukuTheme.light(), home: child),
    );

void main() {
  testWidgets('ErrorScreen はエラー文言と再試行・検索に戻る導線を表示する', (tester) async {
    final container = ProviderContainer(
      overrides: [
        routeServiceProvider.overrideWithValue(_ThrowingRouteService()),
      ],
    );
    addTearDown(container.dispose);

    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container, const ErrorScreen()));

    expect(find.text('ルートを取得できませんでした'), findsOneWidget);
    expect(find.text('再試行'), findsOneWidget);
    expect(find.text('検索に戻る'), findsOneWidget);

    await tester.tap(find.text('検索に戻る'));
    await tester.pump();
    expect(container.read(appStateProvider).screen, Screen.search);
  });

  testWidgets('ResultScreen は route が null のとき空画面でなく復帰導線を出す', (tester) async {
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
