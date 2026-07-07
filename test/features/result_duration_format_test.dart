import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/result/result_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const ResultScreen(),
  ),
);

ProviderContainer _containerFor(RoutePlan plan) {
  final container = ProviderContainer(
    overrides: [
      routeServiceProvider.overrideWithValue(_FixedRouteService(plan)),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

RoutePlan _planWith({
  required int totalMin,
  required int budgetMin,
  int kcal = 120,
  double walkKm = 4,
  double totalKm = 4,
}) => RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: totalKm,
  totalMin: totalMin,
  budgetMin: budgetMin,
  kcal: kcal,
  walkKm: walkKm,
  walkRatio: 1,
  segments: [
    RouteSegment(
      type: SegmentType.walk,
      fromName: 'A',
      toName: 'B',
      km: walkKm,
      minutes: totalMin,
      kcal: kcal,
    ),
  ],
  timelineNodes: const [TimelineNode(time: '9:00', place: 'A', sub: '出発')],
);

Future<void> _pump(WidgetTester tester, ProviderContainer container) async {
  await container.read(appStateProvider.notifier).startSearch();
  await tester.pumpWidget(_wrap(container));
  await tester.pump();
}

void main() {
  group('結果画面の所要時間表記', () {
    testWidgets('60分以上は 時間と分を別表示し折り返さない', (tester) async {
      final container = _containerFor(_planWith(totalMin: 100, budgetMin: 120));
      await _pump(tester, container);

      // 数字と単位を別Textに分割（桁揃え数字と日本語の混植・折り返しを解消）。
      expect(find.text('1'), findsWidgets);
      expect(find.text('時間'), findsWidgets);
      expect(find.text('40'), findsWidgets);
      expect(find.text('分'), findsWidgets);
      // スペース入りの結合表記（折り返しの原因）は廃止。
      expect(find.text('1時間 40分'), findsNothing);
    });

    testWidgets('60分未満は「分」のみで表示し 0時 を出さない', (tester) async {
      final container = _containerFor(_planWith(totalMin: 45, budgetMin: 60));
      await _pump(tester, container);

      expect(find.text('45'), findsWidgets);
      expect(find.text('分'), findsWidgets);
      // 所要時間カラムには「時間」を出さない。
      expect(find.text('時間'), findsNothing);
      expect(find.textContaining('0時'), findsNothing);
    });

    testWidgets('所要が60分以上なら n時間m分 に分解される', (tester) async {
      final container = _containerFor(_planWith(totalMin: 75, budgetMin: 120));
      await _pump(tester, container);

      // 75分 ではなく 1時間15分 に分解される。
      expect(find.text('75'), findsNothing);
      expect(find.text('時間'), findsWidgets);
      expect(find.text('15'), findsWidgets);
    });
  });

  group('結果画面の集計ストリップ', () {
    testWidgets('所要時間・徒歩距離・消費カロリーのラベルを表示する', (tester) async {
      final container = _containerFor(_planWith(totalMin: 60, budgetMin: 120));
      await _pump(tester, container);

      expect(find.text('所要時間'), findsOneWidget);
      expect(find.text('徒歩距離'), findsOneWidget);
      expect(find.text('消費カロリー'), findsOneWidget);
    });

    testWidgets('左から 所要時間 → 徒歩距離 → 消費カロリー の順に並ぶ', (tester) async {
      final container = _containerFor(_planWith(totalMin: 60, budgetMin: 120));
      await _pump(tester, container);

      final timeX = tester.getTopLeft(find.text('所要時間')).dx;
      final walkX = tester.getTopLeft(find.text('徒歩距離')).dx;
      final kcalX = tester.getTopLeft(find.text('消費カロリー')).dx;
      expect(timeX, lessThan(walkX));
      expect(walkX, lessThan(kcalX));
    });

    testWidgets('徒歩距離は walkKm を表示する（totalKm ではない）', (tester) async {
      final container = _containerFor(
        _planWith(totalMin: 60, budgetMin: 120, walkKm: 8.3, totalKm: 20),
      );
      await _pump(tester, container);

      expect(find.text('8.3'), findsWidgets);
      expect(find.text('km'), findsWidgets);
    });

    testWidgets('消費カロリーは値と kcal 単位を表示する', (tester) async {
      final container = _containerFor(
        _planWith(totalMin: 60, budgetMin: 120, kcal: 471),
      );
      await _pump(tester, container);

      expect(find.text('471'), findsWidgets);
      expect(find.text('kcal'), findsWidgets);
    });
  });
}
