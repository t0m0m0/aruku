import 'dart:async';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/features/search/places_provider.dart';
import 'package:aruku/features/search/search_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../e2e/support/e2e_helpers.dart';

const _field = Key('desktop-typeahead-input-destination');
const _dropdown = Key('desktop-typeahead-dropdown-destination');

class _StubPlacesService implements PlacesService {
  const _StubPlacesService();

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async => const [
    PlacePrediction(placeId: 'p1', name: '渋谷ヒカリエ', address: '渋谷区渋谷'),
    PlacePrediction(placeId: 'p2', name: '渋谷スクランブル交差点', address: '渋谷区道玄坂'),
    PlacePrediction(placeId: 'p3', name: '渋谷駅', address: '渋谷区渋谷'),
  ];

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async =>
      const GeoPoint(35.6580, 139.7016);
}

/// fetchLatLng を外から解放できる。確定待ちの間に打ち替える経路を作る。
class _SlowPlacesService implements PlacesService {
  _SlowPlacesService(this.gate);

  final Completer<GeoPoint?> gate;

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async => const [
    PlacePrediction(placeId: 'p1', name: '渋谷ヒカリエ', address: '渋谷区渋谷'),
  ];

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) => gate.future;
}

class _FailingPlacesService implements PlacesService {
  const _FailingPlacesService();

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async => throw const PlacesException('REQUEST_DENIED');

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async => null;
}

Future<ProviderContainer> _pumpHome(
  WidgetTester tester,
  double width, {
  PlacesService places = const _StubPlacesService(),
}) async {
  tester.view.physicalSize = Size(width, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final container = await makeContainer(placesService: places);
  addTearDown(container.dispose);
  await tester.pumpWidget(appWidget(container));
  await pumpTransition(tester);
  return container;
}

/// 入力してデバウンス（400ms）を越えるまで進める。
Future<void> _query(WidgetTester tester, String text) async {
  await tester.tap(find.byKey(_field));
  await tester.pump();
  await tester.enterText(find.byKey(_field), text);
  await tester.pump(const Duration(milliseconds: 500));
  await tester.pump();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('モバイル幅では従来どおり全画面の検索へ遷移する', (tester) async {
    final container = await _pumpHome(tester, 819);

    expect(find.byKey(_field), findsNothing);
    await tester.tap(find.byKey(const Key('home-destination-search')));
    await pumpTransition(tester);

    expect(container.read(appStateProvider).screen, Screen.search);
    expect(find.byType(SearchScreen), findsOneWidget);
  });

  testWidgets('デスクトップ幅では画面遷移せずインライン入力になる', (tester) async {
    final container = await _pumpHome(tester, 1280);

    expect(find.byKey(_field), findsOneWidget);
    await tester.tap(find.byKey(_field));
    await tester.pump();

    expect(container.read(appStateProvider).screen, Screen.home);
  });

  testWidgets('入力すると候補のドロップダウンが開く', (tester) async {
    await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');

    expect(find.byKey(_dropdown), findsOneWidget);
    expect(find.text('渋谷ヒカリエ'), findsOneWidget);
    expect(find.text('渋谷駅'), findsOneWidget);
  });

  // 先頭候補が最初からハイライトされている。Enter だけで先頭を確定できる。
  testWidgets('入力直後の Enter は先頭候補を確定する', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).destination, '渋谷ヒカリエ');
    expect(find.byKey(_dropdown), findsNothing);
  });

  testWidgets('↓↑ で候補を移動し Enter で確定する', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).destination, '渋谷スクランブル交差点');
    expect(find.byKey(_dropdown), findsNothing);
  });

  // 端で止める。先頭より上・末尾より下へ回り込むと、連打でどこにいるか
  // 見失う。
  testWidgets('ハイライトは先頭と末尾で止まる', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');

    for (var i = 0; i < 5; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).destination, '渋谷駅');
  });

  testWidgets('候補をクリックしても確定する', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');

    await tester.tap(find.text('渋谷駅'));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).destination, '渋谷駅');
  });

  testWidgets('Esc で閉じ、目的地は変わらない', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();

    expect(find.byKey(_dropdown), findsNothing);
    expect(container.read(appStateProvider).destination, isNull);
  });

  // 全画面検索は「選ばずに戻れば何も変わらない」構造だった。インラインは
  // 入力欄と確定済みの値が同じ場所に同居するため、遷移が持っていた不変条件を
  // 状態側で作り直す必要がある。
  testWidgets('確定後に打ち替え始めると目的地は無効になる', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');
    await tester.tap(find.text('渋谷駅'));
    await tester.pumpAndSettle();
    expect(container.read(appStateProvider).destination, '渋谷駅');

    await tester.tap(find.byKey(_field));
    await tester.pump();
    await tester.enterText(find.byKey(_field), '新宿');
    await tester.pump(const Duration(milliseconds: 500));

    expect(container.read(appStateProvider).destination, isNull);
  });

  testWidgets('取得に失敗したら候補なしではなく失敗として出す', (tester) async {
    await _pumpHome(tester, 1280, places: const _FailingPlacesService());
    await _query(tester, '渋谷');

    expect(find.textContaining('検索できませんでした'), findsOneWidget);
    expect(find.text('候補が見つかりませんでした'), findsNothing);
  });

  // 焦点が入っただけでは確定済みの目的地を捨てない。捨てるのは打ち替えを
  // 始めたとき（欄の表示と状態がずれる瞬間）だけ。
  testWidgets('未入力で焦点が入ると履歴を出す', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');
    await tester.tap(find.text('渋谷駅'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(_field));
    await tester.pumpAndSettle();

    expect(find.text('最近の目的地'), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(_dropdown), matching: find.text('渋谷駅')),
      findsOneWidget,
    );
    expect(container.read(appStateProvider).destination, '渋谷駅');
  });

  // 全画面検索で入れた「近くの店」を引き継ぐと、以後の候補が理由の見えない
  // まま距離順で並び続ける。インラインにはトグルが無い。
  testWidgets('焦点が入ると近くの店モードを解除する', (tester) async {
    final container = await _pumpHome(tester, 1280);
    container.read(placesProvider.notifier).setNearby(true);

    await tester.tap(find.byKey(_field));
    await tester.pump();

    expect(container.read(placesProvider).nearby, isFalse);
  });

  testWidgets('目的地未選択の CTA はインライン入力へ焦点を移す', (tester) async {
    final container = await _pumpHome(tester, 1280);

    await tester.tap(find.text('目的地を選ぶ'));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.home);
    expect(
      tester.widget<TextField>(find.byKey(_field)).focusNode?.hasFocus,
      isTrue,
    );
  });

  // 確定を待つ間も欄は編集できる。遅れて返った古い確定が、打ち替えた後の
  // クエリを消して別の地点を入れてしまう。
  testWidgets('打ち替えた後に返ってきた古い確定は捨てる', (tester) async {
    final gate = Completer<GeoPoint?>();
    final container = await _pumpHome(
      tester,
      1280,
      places: _SlowPlacesService(gate),
    );
    await _query(tester, '渋谷');

    await tester.tap(find.text('渋谷ヒカリエ'));
    await tester.pump();

    await tester.enterText(find.byKey(_field), '新宿');
    await tester.pump(const Duration(milliseconds: 500));

    gate.complete(const GeoPoint(35.6580, 139.7016));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).destination, isNull);
    expect(tester.widget<TextField>(find.byKey(_field)).controller?.text, '新宿');
  });

  testWidgets('外側をクリックすると閉じる', (tester) async {
    await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');

    await tester.tapAt(const Offset(20, 400));
    await tester.pump();

    expect(find.byKey(_dropdown), findsNothing);
  });
}
