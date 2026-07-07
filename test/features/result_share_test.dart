import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/services/share_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FixedRouteService implements RouteService {
  _FixedRouteService(this.result);
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
  }) async => result;
}

const _plan = RoutePlan(
  from: '現在地',
  to: '渋谷駅',
  totalKm: 4,
  totalMin: 40,
  budgetMin: 60,
  kcal: 150,
  walkKm: 4,
  walkRatio: 1,
  segments: [],
  timelineNodes: [TimelineNode(time: '9:00', place: '現在地', sub: '出発')],
);

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const ResultScreen(),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('共有ボタンをタップするとルート概要テキストを共有する', (tester) async {
    ShareParams? captured;
    final fakeShare = ShareService(
      invoker: (params) async {
        captured = params;
        return const ShareResult('ok', ShareResultStatus.success);
      },
    );

    final container = ProviderContainer(
      overrides: [
        routeServiceProvider.overrideWithValue(_FixedRouteService(_plan)),
        shareServiceProvider.overrideWithValue(fakeShare),
      ],
    );
    addTearDown(container.dispose);

    container.read(appStateProvider.notifier).setDestination('渋谷駅');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    final shareBtn = find.byKey(const ValueKey('result-share-button'));
    expect(shareBtn, findsOneWidget);

    await tester.tap(shareBtn);
    await tester.pump();

    final text = captured?.text ?? '';
    expect(text, contains('現在地'));
    expect(text, contains('渋谷駅'));
    expect(text, contains('4.0'));
    expect(text, contains('150'));
    expect(text, contains('#アルク'));
  });

  testWidgets('共有が失敗しても未捕捉例外にならない', (tester) async {
    final throwingShare = ShareService(
      invoker: (_) async => throw Exception('share failed'),
    );

    final container = ProviderContainer(
      overrides: [
        routeServiceProvider.overrideWithValue(_FixedRouteService(_plan)),
        shareServiceProvider.overrideWithValue(throwingShare),
      ],
    );
    addTearDown(container.dispose);

    container.read(appStateProvider.notifier).setDestination('渋谷駅');
    await container.read(appStateProvider.notifier).startSearch();
    await tester.pumpWidget(_wrap(container));
    await tester.pump();

    await tester.tap(find.byKey(const ValueKey('result-share-button')));
    await tester.pump();

    expect(tester.takeException(), isNull);
  });
}
