import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _FakeActivityService implements ActivityService {
  _FakeActivityService(this._controller);

  final StreamController<ActivitySnapshot> _controller;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => _controller.stream;
}

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(theme: ArukuTheme.light(), home: const HomeScreen()),
);

Future<ProviderContainer> _pumpHome(
  WidgetTester tester, {
  StreamController<ActivitySnapshot>? controller,
}) async {
  SharedPreferences.setMockInitialValues({});
  final repo = ActivityLogRepository(await SharedPreferences.getInstance());
  final ctrl = controller ?? StreamController<ActivitySnapshot>();
  final container = ProviderContainer(
    overrides: [
      activityServiceProvider.overrideWithValue(_FakeActivityService(ctrl)),
      locationServiceProvider.overrideWithValue(_FakeLocationService()),
      activityLogRepositoryProvider.overrideWith((ref) async => repo),
    ],
  );
  addTearDown(container.dispose);
  if (controller == null) addTearDown(ctrl.close);

  container.read(appStateProvider); // build() を起動
  await tester.pumpWidget(_wrap(container));
  await tester.pump();
  return container;
}

void main() {
  testWidgets('ヘッダのストリークチップは廃止され、目標カードに統合される', (tester) async {
    final container = await _pumpHome(tester);

    // 週次目標カードのラベルが表示される（旧 moss50 サマリーバーは撤去）。
    expect(find.text('今週の目標 10km'), findsOneWidget);
    expect(find.byKey(const Key('home-weekly-goal')), findsOneWidget);
    // 旧サマリーバーの「歩数」ラベルは存在しない。
    expect(find.text('歩数'), findsNothing);

    container.dispose();
  });

  testWidgets('目的地が未設定のとき、CTA と目的地カードが選択を促す', (tester) async {
    await _pumpHome(tester);

    expect(find.text('どこへ歩く?'), findsOneWidget);
    expect(find.text('目的地を選ぶ'), findsOneWidget);
    expect(find.text('ルートを検索'), findsNothing);
    // 現在地再取得のコンパスボタンが存在する。
    expect(find.byKey(const Key('home-origin-compass')), findsOneWidget);
  });

  testWidgets('目的地を設定すると CTA が「ルートを検索」に変わる', (tester) async {
    final container = await _pumpHome(tester);

    container.read(appStateProvider.notifier).setDestination('渋谷ヒカリエ');
    await tester.pump();

    expect(find.text('渋谷ヒカリエ'), findsOneWidget);
    expect(find.text('ルートを検索'), findsOneWidget);
    expect(find.text('目的地を選ぶ'), findsNothing);
  });

  testWidgets('目的地未設定で CTA を押すと検索画面へ遷移する', (tester) async {
    final container = await _pumpHome(tester);

    await tester.tap(find.text('目的地を選ぶ'));
    await tester.pump();

    expect(container.read(appStateProvider).screen, Screen.search);
  });

  testWidgets('計測した歩数が目標カードに表示される', (tester) async {
    final controller = StreamController<ActivitySnapshot>();
    addTearDown(controller.close);
    await _pumpHome(tester, controller: controller);

    await tester.runAsync(() async {
      await Future<void>.delayed(Duration.zero);
      controller.add(ActivitySnapshot.fromSteps(2000));
      await Future<void>.delayed(Duration.zero);
    });
    await tester.pump();

    expect(find.text('2,000'), findsOneWidget);
    expect(find.textContaining('歩'), findsWidgets);
  });
}
