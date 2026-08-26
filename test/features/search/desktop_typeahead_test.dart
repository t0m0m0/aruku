import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/state/app_state.dart';
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

Future<ProviderContainer> _pumpHome(WidgetTester tester, double width) async {
  tester.view.physicalSize = Size(width, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final container = await makeContainer(
    placesService: const _StubPlacesService(),
  );
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

  testWidgets('外側をクリックすると閉じる', (tester) async {
    await _pumpHome(tester, 1280);
    await _query(tester, '渋谷');

    await tester.tapAt(const Offset(20, 400));
    await tester.pump();

    expect(find.byKey(_dropdown), findsNothing);
  });
}
