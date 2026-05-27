import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/navigation/nav_engine.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/navigation/nav_screen.dart';
import 'package:aruku/shared/widgets/aruku_map.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../../support/route_plan_fixtures.dart';

/// build() で位置取得を起動せず、preset した状態を返すテスト用 Notifier。
class _NavNotifier extends AppNotifier {
  _NavNotifier(this._initial);
  final AppState _initial;

  @override
  AppState build() => _initial;

  void setPos(GeoPoint p) => state = state.copyWith(currentPosition: p);
}

String _percent(GeoPoint current) {
  final g = computeGuidance(route: sampleRoutePlan, current: current);
  return '${(g.progress * 100).round()}%';
}

void main() {
  // 経路上の途中点と終端付近。進捗率が異なる。
  const mid = GeoPoint(35.6790, 139.7035);
  const nearEnd = GeoPoint(35.6585, 139.7025);

  Widget wrap(_NavNotifier notifier) => ProviderScope(
    overrides: [appStateProvider.overrideWith(() => notifier)],
    child: MaterialApp(theme: ArukuTheme.light(), home: const NavScreen()),
  );

  AppState navState() => AppState.initial.copyWith(
    screen: Screen.nav,
    route: sampleRoutePlan,
    currentPosition: mid,
  );

  testWidgets('現在地から算出した進捗率を表示する', (tester) async {
    await tester.pumpWidget(wrap(_NavNotifier(navState())));
    await tester.pump();

    expect(find.text(_percent(mid)), findsOneWidget);
    // プレースホルダ「0%」ではない実値が出ている。
    expect(_percent(mid), isNot('0%'));
  });

  testWidgets('現在地が進むと表示が更新される（実移動に追従）', (tester) async {
    final notifier = _NavNotifier(navState());
    await tester.pumpWidget(wrap(notifier));
    await tester.pump();

    final before = _percent(mid);
    expect(find.text(before), findsOneWidget);

    notifier.setPos(nearEnd);
    await tester.pump();

    final after = _percent(nearEnd);
    expect(after, isNot(before));
    expect(find.text(after), findsOneWidget);
    expect(find.text(before), findsNothing);
  });

  testWidgets('レイヤーチップで地図種別が通常↔航空写真に切り替わる', (tester) async {
    await tester.pumpWidget(wrap(_NavNotifier(navState())));
    await tester.pump();

    ArukuMap mapWidget() => tester.widget<ArukuMap>(find.byType(ArukuMap));
    expect(mapWidget().mapType, MapType.normal);

    await tester.tap(find.byKey(const Key('nav-layer-chip')));
    await tester.pump();
    expect(mapWidget().mapType, MapType.hybrid);

    await tester.tap(find.byKey(const Key('nav-layer-chip')));
    await tester.pump();
    expect(mapWidget().mapType, MapType.normal);
  });
}
