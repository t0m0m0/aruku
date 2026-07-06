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

  testWidgets('終了ボタンをタップするとホームへ戻る', (tester) async {
    final notifier = _NavNotifier(navState());
    await tester.pumpWidget(wrap(notifier));
    await tester.pump();

    expect(find.text('終了'), findsOneWidget);

    await tester.tap(find.byKey(const Key('nav-exit-button')));
    await tester.pump();

    expect(notifier.state.screen, Screen.home);
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

  testWidgets('「一時停止 · 寄り道」ボタンは表示しない', (tester) async {
    await tester.pumpWidget(wrap(_NavNotifier(navState())));
    await tester.pump();

    expect(find.text('一時停止 · 寄り道'), findsNothing);
  });

  testWidgets('電車乗車前は路線名付きの乗車案内を表示し、電車アイコンを出す', (tester) async {
    // sampleRoutePlanの徒歩区間終盤（電車区間手前）。
    await tester.pumpWidget(wrap(_NavNotifier(navState())));
    await tester.pump();

    expect(find.textContaining('JR山手線に乗車'), findsOneWidget);
    expect(find.byKey(const Key('nav-maneuver-icon-train')), findsOneWidget);
  });

  testWidgets('電車乗車中は降車駅名付きの下車案内を表示し、電車アイコンを出す', (tester) async {
    const onTrain = GeoPoint(35.6640, 139.7020);
    await tester.pumpWidget(
      wrap(_NavNotifier(navState().copyWith(currentPosition: onTrain))),
    );
    await tester.pump();

    expect(find.textContaining('渋谷で下車'), findsOneWidget);
    expect(find.byKey(const Key('nav-maneuver-icon-train')), findsOneWidget);
  });

  testWidgets('まもなく到着時は到着アイコンを表示する', (tester) async {
    const arriveNear = GeoPoint(35.6591, 139.7030);
    await tester.pumpWidget(
      wrap(_NavNotifier(navState().copyWith(currentPosition: arriveNear))),
    );
    await tester.pump();

    expect(find.byKey(const Key('nav-maneuver-icon-arrive')), findsOneWidget);
  });

  testWidgets('左折時は左折アイコンを表示する（直進矢印固定ではない）', (tester) async {
    const beforeTurn = GeoPoint(35.0, 139.001);
    await tester.pumpWidget(
      wrap(
        _NavNotifier(
          navState().copyWith(
            route: leftTurnRoutePlan,
            currentPosition: beforeTurn,
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('nav-maneuver-icon-left')), findsOneWidget);
    expect(find.byKey(const Key('nav-maneuver-icon-straight')), findsNothing);
  });

  group('地図の自動追従', () {
    testWidgets('初期状態では「現在地に戻る」ボタンを表示しない', (tester) async {
      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      expect(find.byKey(const Key('nav-recenter-button')), findsNothing);
    });

    testWidgets('地図をユーザーが操作すると「現在地に戻る」ボタンを表示する', (tester) async {
      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      final map = tester.widget<ArukuMap>(find.byType(ArukuMap));
      map.onCameraMoveStarted!();
      await tester.pump();

      expect(find.byKey(const Key('nav-recenter-button')), findsOneWidget);
    });

    testWidgets('「現在地に戻る」をタップすると追従を再開しボタンが消える', (tester) async {
      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      tester.widget<ArukuMap>(find.byType(ArukuMap)).onCameraMoveStarted!();
      await tester.pump();
      expect(find.byKey(const Key('nav-recenter-button')), findsOneWidget);

      await tester.tap(find.byKey(const Key('nav-recenter-button')));
      await tester.pump();

      expect(find.byKey(const Key('nav-recenter-button')), findsNothing);
    });
  });

  group('navCameraPosition', () {
    test('ナビ視点のズーム/チルトを維持したカメラ位置を返す', () {
      const pos = GeoPoint(35.681, 139.767);

      final cam = navCameraPosition(pos);

      expect(cam.target, const LatLng(35.681, 139.767));
      expect(cam.zoom, ArukuMapVariant.nav.zoom);
      expect(cam.tilt, ArukuMapVariant.nav.tilt);
    });
  });
}
