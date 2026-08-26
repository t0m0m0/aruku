import 'package:aruku/core/config/layout_breakpoints.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:aruku/shared/widgets/aruku_map.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/route_plan_fixtures.dart';

const _leftPanel = Key('result-desktop-left-panel');
const _map = Key('result-desktop-map');
const _cta = Key('result-desktop-cta');

class _FixedRouteService implements RouteService {
  const _FixedRouteService(this.result);
  final RoutePlan result;

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
  }) async => result;
}

Future<void> _pumpResult(WidgetTester tester, {required bool desktop}) async {
  tester.view.physicalSize = Size(desktop ? 1280 : 800, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final container = ProviderContainer(
    overrides: [
      routeServiceProvider.overrideWithValue(
        const _FixedRouteService(sampleRoutePlan),
      ),
      isDesktopLayoutProvider.overrideWithValue(desktop),
    ],
  );
  addTearDown(container.dispose);
  await container.read(appStateProvider.notifier).startSearch();

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ArukuTheme.light(),
        home: const ResultScreen(),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('モバイル幅では従来の1カラムのまま', (tester) async {
    await _pumpResult(tester, desktop: false);

    expect(find.byKey(_leftPanel), findsNothing);
    expect(find.byKey(_map), findsNothing);
    expect(find.byType(ArukuMap), findsOneWidget);
  });

  testWidgets('デスクトップ幅では左パネルと地図の2カラムになる', (tester) async {
    await _pumpResult(tester, desktop: true);

    expect(find.byKey(_leftPanel), findsOneWidget);
    expect(find.byKey(_map), findsOneWidget);
    // 地図は分割ビューの右側だけ。カード内のプレビューと二重に出さない。
    expect(find.byType(ArukuMap), findsOneWidget);
  });

  testWidgets('左パネルの幅は 340–400px に収まる', (tester) async {
    await _pumpResult(tester, desktop: true);

    final width = tester.getSize(find.byKey(_leftPanel)).width;
    expect(width, greaterThanOrEqualTo(340));
    expect(width, lessThanOrEqualTo(400));
  });

  testWidgets('地図は左パネルの右側で残り幅を占める', (tester) async {
    await _pumpResult(tester, desktop: true);

    final panel = tester.getRect(find.byKey(_leftPanel));
    final map = tester.getRect(find.byKey(_map));

    expect(map.left, panel.right);
    expect(map.right, 1280);
  });

  // 左パネルは内部スクロール。CTA を一緒に流すと画面外へ押し出される（#262）。
  testWidgets('CTA は左パネルの内側の底に留まる', (tester) async {
    await _pumpResult(tester, desktop: true);

    final panel = tester.getRect(find.byKey(_leftPanel));
    final cta = tester.getRect(find.byKey(_cta));

    expect(cta.left, greaterThanOrEqualTo(panel.left));
    expect(cta.right, lessThanOrEqualTo(panel.right));
    expect(cta.bottom, lessThanOrEqualTo(panel.bottom));
  });
}
