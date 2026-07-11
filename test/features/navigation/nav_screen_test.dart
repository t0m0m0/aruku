import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/navigation/nav_engine.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/navigation/nav_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:aruku/shared/widgets/aruku_map.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:wakelock_plus_platform_interface/wakelock_plus_platform_interface.dart';

import '../../support/route_plan_fixtures.dart';

/// wakelock の toggle 呼び出しを記録するテスト用フェイク実装。
class _FakeWakelockPlatform extends WakelockPlusPlatformInterface {
  final calls = <bool>[];

  @override
  Future<void> toggle({required bool enable}) async {
    calls.add(enable);
  }

  @override
  Future<bool> get enabled async => calls.isNotEmpty && calls.last;
}

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
    child: MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: ArukuTheme.light(),
      home: const NavScreen(),
    ),
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

  group('GPS初回フィックス前の表示', () {
    testWidgets('現在地未取得時は到着・消費欄に取得中を表示し、無関係な代替値を出さない', (tester) async {
      final noFixState = AppState.initial.copyWith(
        screen: Screen.nav,
        route: sampleRoutePlan,
        todayKcal: 999,
      );
      await tester.pumpWidget(wrap(_NavNotifier(noFixState)));
      await tester.pump();

      // 到着・消費の両欄とも guidance の有無だけで駆動されるため常に同時に
      // 切り替わる。片方だけ「取得中」のままになるケースは存在しない。
      expect(find.text('取得中'), findsNWidgets(2));
      expect(find.text(noFixState.arrival.format()), findsNothing);
      expect(find.text('999'), findsNothing);
    });

    testWidgets('現在地取得後は取得中が消え実値に切り替わる', (tester) async {
      final notifier = _NavNotifier(
        AppState.initial.copyWith(
          screen: Screen.nav,
          route: sampleRoutePlan,
          todayKcal: 999,
        ),
      );
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();
      expect(find.text('取得中'), findsNWidgets(2));

      notifier.setPos(mid);
      await tester.pump();

      expect(find.text('取得中'), findsNothing);
    });
  });

  group('GPS喪失・リルート失敗のフィードバック', () {
    testWidgets('位置情報が取得できない状態ではGPS喪失バナーを表示する', (tester) async {
      final notifier = _NavNotifier(
        navState().copyWith(locationState: const LocationUnavailable()),
      );
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();

      expect(find.text('現在地を取得できません。電波状況の良い場所で再試行します'), findsOneWidget);
    });

    testWidgets('位置情報が取得できている間はGPS喪失バナーを表示しない', (tester) async {
      final notifier = _NavNotifier(navState());
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();

      expect(find.text('現在地を取得できません。電波状況の良い場所で再試行します'), findsNothing);
    });

    testWidgets('リルート失敗時は失敗バナーを表示する', (tester) async {
      final notifier = _NavNotifier(navState().copyWith(rerouteFailed: true));
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();

      expect(find.text('再検索に失敗しました。旧ルートを表示中'), findsOneWidget);
    });

    testWidgets('リルート失敗していない間は失敗バナーを表示しない', (tester) async {
      final notifier = _NavNotifier(navState());
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();

      expect(find.text('再検索に失敗しました。旧ルートを表示中'), findsNothing);
    });
  });

  group('ナビ終了の確認', () {
    testWidgets('終了ボタンをタップすると確認ダイアログを表示し、即座には戻らない', (tester) async {
      final notifier = _NavNotifier(navState());
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();

      await tester.tap(find.byKey(const Key('nav-exit-button')));
      await tester.pump();

      expect(find.text('ナビを終了しますか？'), findsOneWidget);
      expect(notifier.state.screen, Screen.nav);
    });

    testWidgets('確認ダイアログで「終了」を選ぶとホームへ戻る', (tester) async {
      final notifier = _NavNotifier(navState());
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();

      await tester.tap(find.byKey(const Key('nav-exit-button')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('nav-exit-confirm-button')));
      await tester.pump();

      expect(notifier.state.screen, Screen.home);
      expect(find.text('ナビを終了しますか？'), findsNothing);
    });

    testWidgets('確認ダイアログで「キャンセル」を選ぶとナビ画面に留まる', (tester) async {
      final notifier = _NavNotifier(navState());
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();

      await tester.tap(find.byKey(const Key('nav-exit-button')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('nav-exit-cancel-button')));
      await tester.pump();

      expect(notifier.state.screen, Screen.nav);
      expect(find.text('ナビを終了しますか？'), findsNothing);
    });

    testWidgets('システムバックでも確認ダイアログを表示し、終了/キャンセルの分岐が効く', (tester) async {
      final notifier = _NavNotifier(navState());
      await tester.pumpWidget(wrap(notifier));
      await tester.pump();

      final popScopeFinder = find.byWidgetPredicate((w) => w is PopScope);
      final popScope = tester.widget(popScopeFinder) as PopScope;
      expect(popScope.canPop, isFalse);

      popScope.onPopInvokedWithResult!(false, null);
      await tester.pump();
      expect(find.text('ナビを終了しますか？'), findsOneWidget);

      await tester.tap(find.byKey(const Key('nav-exit-cancel-button')));
      await tester.pump();
      expect(notifier.state.screen, Screen.nav);

      (tester.widget(popScopeFinder) as PopScope).onPopInvokedWithResult!(
        false,
        null,
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('nav-exit-confirm-button')));
      await tester.pump();
      expect(notifier.state.screen, Screen.home);
    });
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

  group('残り距離の徒歩／全行程表示', () {
    testWidgets('電車を含む経路では「残り（徒歩）」と「全行程」の2段を表示する', (tester) async {
      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      expect(find.text('残り（徒歩）'), findsOneWidget);
      expect(find.textContaining('全行程'), findsOneWidget);
      // 全行程が併記される以上、単一の「残り」ラベルは出さない。
      expect(find.text('残り'), findsNothing);
    });

    testWidgets('徒歩のみ経路では単一の「残り」表示にとどめ全行程を併記しない', (tester) async {
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

      expect(find.text('残り'), findsOneWidget);
      expect(find.text('残り（徒歩）'), findsNothing);
      expect(find.textContaining('全行程'), findsNothing);
    });
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

  group('wakelock', () {
    late _FakeWakelockPlatform fake;
    late WakelockPlusPlatformInterface original;

    setUp(() {
      fake = _FakeWakelockPlatform();
      original = wakelockPlusPlatformInstance;
      wakelockPlusPlatformInstance = fake;
    });

    tearDown(() {
      wakelockPlusPlatformInstance = original;
    });

    testWidgets('ナビ画面表示中はスリープ防止を有効化する', (tester) async {
      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      expect(fake.calls, contains(true));
    });

    testWidgets('ナビ画面を離れるとスリープ防止を解除する', (tester) async {
      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await tester.pump();

      expect(fake.calls.last, isFalse);
    });
  });

  group('右側チップ列のレイアウト', () {
    testWidgets('セーフエリアの上部インセットより下に配置される（固定値でオーバーラップしない）', (tester) async {
      tester.view.devicePixelRatio = 1.0;
      tester.view.padding = const FakeViewPadding(top: 300);
      addTearDown(tester.view.resetPadding);

      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      final chipTop = tester
          .getTopLeft(find.byKey(const Key('nav-layer-chip')))
          .dy;

      expect(chipTop, greaterThanOrEqualTo(300));
    });
  });

  group('チップのアクセシビリティラベル', () {
    testWidgets('レイヤー切替・コンパスの各チップにSemanticsラベルを持つ', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      expect(find.bySemanticsLabel('地図の種別を切り替える'), findsOneWidget);
      expect(find.bySemanticsLabel('地図を北向きに戻す'), findsOneWidget);

      handle.dispose();
    });
  });

  group('文字拡大設定への対応', () {
    testWidgets('文字拡大を最大にしても案内カード・下部バーがオーバーフローしない', (tester) async {
      // 狭い実機幅で検証する。既定のテスト面（幅800）は横方向のあふれを覆い隠す。
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      tester.platformDispatcher.textScaleFactorTestValue = 3.0;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();

      expect(tester.takeException(), isNull);
    });
  });

  group('現在地マーカーの方向表示', () {
    Marker currentMarker(WidgetTester tester) => tester
        .widget<ArukuMap>(find.byType(ArukuMap))
        .markers
        .firstWhere((m) => m.markerId == const MarkerId('current'));

    testWidgets('headingがあればマーカーをその向きに回転させる', (tester) async {
      const withHeading = GeoPoint(35.6790, 139.7035, heading: 45.0);
      await tester.pumpWidget(
        wrap(_NavNotifier(navState().copyWith(currentPosition: withHeading))),
      );
      await tester.pump();
      await tester.pump();

      final marker = currentMarker(tester);
      expect(marker.rotation, 45.0);
      expect(marker.flat, isTrue);
    });

    testWidgets('heading未取得時は回転させない', (tester) async {
      await tester.pumpWidget(wrap(_NavNotifier(navState())));
      await tester.pump();
      await tester.pump();

      final marker = currentMarker(tester);
      expect(marker.rotation, 0.0);
    });

    group('currentLocationMarker（アイコン読込状況ごとのアンカー整合性）', () {
      // dart:ui を使うアイコン生成は実機非同期処理のためウィジェットテストの
      // pump では待てない。マーカー組み立てをピュア関数として切り出し、
      // アイコンの読込状況を直接注入して検証する。
      final fakeIcon = BitmapDescriptor.defaultMarkerWithHue(
        BitmapDescriptor.hueGreen,
      );
      const withHeading = GeoPoint(35.6790, 139.7035, heading: 45.0);

      test('heading取得済み・アイコン読込済みなら円形アイコンの中心をアンカーにする', () {
        final marker = currentLocationMarker(
          current: withHeading,
          directionalIcon: fakeIcon,
        );

        expect(marker.anchor, const Offset(0.5, 0.5));
        expect(marker.icon, fakeIcon);
        expect(marker.rotation, 45.0);
        expect(marker.flat, isTrue);
      });

      test('heading取得済みでもアイコン未読込なら涙型ピンの先端をアンカーにする', () {
        final marker = currentLocationMarker(
          current: withHeading,
          directionalIcon: null,
        );

        expect(marker.anchor, const Offset(0.5, 1.0));
      });

      test('heading未取得ならアイコン読込済みでも涙型ピンの先端をアンカーにする', () {
        final marker = currentLocationMarker(
          current: const GeoPoint(35.6790, 139.7035),
          directionalIcon: fakeIcon,
        );

        expect(marker.anchor, const Offset(0.5, 1.0));
        expect(marker.rotation, 0.0);
      });
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
