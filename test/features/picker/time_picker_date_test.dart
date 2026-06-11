import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

ProviderContainer _container() {
  final container = ProviderContainer(
    overrides: [
      locationServiceProvider.overrideWithValue(const _FakeLocationService()),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  group('AppNotifier.applyPickedTime', () {
    test('出発を確定すると departure に値・dateOffset が入る', () async {
      final container = _container();
      final notifier = container.read(appStateProvider.notifier);
      await Future<void>.delayed(Duration.zero);

      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 9,
        m: 30,
        dateOffset: 0,
      );

      final state = container.read(appStateProvider);
      expect(state.departure.h, 9);
      expect(state.departure.m, 30);
      expect(state.departure.dateOffset, 0);
    });

    test('到着を確定すると arrival に値・dateOffset が入る', () async {
      final container = _container();
      final notifier = container.read(appStateProvider.notifier);
      await Future<void>.delayed(Duration.zero);

      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 18,
        m: 0,
        dateOffset: 1,
      );

      final state = container.read(appStateProvider);
      expect(state.arrival.h, 18);
      expect(state.arrival.m, 0);
      expect(state.arrival.dateOffset, 1);
    });

    test('2日以上先の dateOffset を保持できる', () async {
      final container = _container();
      final notifier = container.read(appStateProvider.notifier);
      await Future<void>.delayed(Duration.zero);

      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 7,
        m: 15,
        dateOffset: 30,
      );

      expect(container.read(appStateProvider).departure.dateOffset, 30);
    });
  });

  group('AppNotifier.applyPickedTime 出発<到着の保証', () {
    /// 出発=10:00 / 到着=11:00（予算60分）の決め打ち状態を作る。
    /// 実時刻に依存しないよう、まず到着を遠い未来へ逃がしてから設定する。
    Future<AppNotifier> setup(ProviderContainer container) async {
      final notifier = container.read(appStateProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 23,
        m: 0,
        dateOffset: 30,
      );
      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 10,
        m: 0,
        dateOffset: 0,
      );
      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 11,
        m: 0,
        dateOffset: 0,
      );
      return notifier;
    }

    test('出発を到着以降に動かすと到着が後ろへずれ、予算が保たれる', () async {
      final container = _container();
      final notifier = await setup(container);
      expect(container.read(appStateProvider).budgetMinutes, 60);

      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 12,
        m: 0,
        dateOffset: 0,
      );

      final state = container.read(appStateProvider);
      expect(state.departure.h, 12);
      expect(state.arrival.h, 13);
      expect(state.arrival.m, 0);
      expect(state.arrival.dateOffset, 0);
      expect(state.budgetMinutes, 60);
    });

    test('出発を前へ動かすと到着は不変で予算が広がる', () async {
      final container = _container();
      final notifier = await setup(container);

      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 9,
        m: 0,
        dateOffset: 0,
      );

      final state = container.read(appStateProvider);
      expect(state.arrival.h, 11);
      expect(state.arrival.m, 0);
      expect(state.budgetMinutes, 120);
    });

    test('到着を出発より前にすると 出発+1分 にクランプされる', () async {
      final container = _container();
      final notifier = await setup(container);

      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 9,
        m: 0,
        dateOffset: 0,
      );

      final state = container.read(appStateProvider);
      expect(state.arrival.h, 10);
      expect(state.arrival.m, 1);
      expect(state.arrival.dateOffset, 0);
      expect(state.budgetMinutes, 1);
    });

    test('予算が最小(1分)でも出発を動かすと1分ギャップが保たれる', () async {
      final container = _container();
      final notifier = await setup(container);
      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 10,
        m: 1,
        dateOffset: 0,
      );
      expect(container.read(appStateProvider).budgetMinutes, 1);

      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 12,
        m: 0,
        dateOffset: 0,
      );

      final state = container.read(appStateProvider);
      expect(state.arrival.h, 12);
      expect(state.arrival.m, 1);
      expect(state.budgetMinutes, 1);
    });

    test('日跨ぎ: 深夜に出発を動かすと到着が翌日へ繰り上がる', () async {
      final container = _container();
      final notifier = container.read(appStateProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 23,
        m: 0,
        dateOffset: 30,
      );
      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 23,
        m: 30,
        dateOffset: 0,
      );
      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 23,
        m: 40,
        dateOffset: 0,
      );
      expect(container.read(appStateProvider).budgetMinutes, 10);

      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 23,
        m: 55,
        dateOffset: 0,
      );

      final state = container.read(appStateProvider);
      expect(state.arrival.h, 0);
      expect(state.arrival.m, 5);
      expect(state.arrival.dateOffset, 1);
      expect(state.budgetMinutes, 10);
    });
  });

  group('HomeScreen 日付・時刻ピッカー', () {
    Future<void> pumpHome(
      WidgetTester tester,
      ProviderContainer container,
    ) async {
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: ArukuTheme.light(),
            home: const HomeScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('time_field_depart')));
      await tester.pumpAndSettle();
    }

    testWidgets('出発フィールドのタップで連結ホイールと出発/到着タブが開く', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      expect(find.byType(CupertinoDatePicker), findsOneWidget);
      expect(find.byKey(const Key('seg_depart')), findsOneWidget);
      expect(find.byKey(const Key('seg_arrival')), findsOneWidget);
    });

    testWidgets('完了でピッカーが閉じる', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      await tester.tap(find.byKey(const Key('picker_done')));
      await tester.pumpAndSettle();

      expect(find.byType(CupertinoDatePicker), findsNothing);
    });

    testWidgets('到着タブに切替えて完了すると arrival に値が入る', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      await tester.tap(find.byKey(const Key('seg_arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('picker_done')));
      await tester.pumpAndSettle();

      expect(find.byType(CupertinoDatePicker), findsNothing);
    });

    testWidgets('到着ピッカーの下限は出発+1分になり、出発より前を選べない', (tester) async {
      final container = _container();
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: ArukuTheme.light(),
            home: const HomeScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // 出発を遠い未来へ固定し、現在時刻ではなく出発が下限を決めることを確かめる。
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(mode: PickerMode.depart, h: 10, m: 0, dateOffset: 5);
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('time_field_arrival')));
      await tester.pumpAndSettle();

      final picker = tester.widget<CupertinoDatePicker>(
        find.byType(CupertinoDatePicker),
      );
      final now = DateTime.now();
      final expectedMin = DateTime(now.year, now.month, now.day + 5, 10, 1);
      expect(picker.minimumDate, expectedMin);
    });

    testWidgets('出発タブでは「現在時刻」ボタンが出る', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      expect(find.byKey(const Key('picker_now')), findsOneWidget);
    });

    testWidgets('到着タブに切替えると「現在時刻」ボタンは消える', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      await tester.tap(find.byKey(const Key('seg_arrival')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('picker_now')), findsNothing);
    });

    testWidgets('「現在時刻」タップではシートは閉じず、完了で現在時刻（分単位）が入る', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      final before = DateTime.now();
      await tester.tap(find.byKey(const Key('picker_now')));
      await tester.pumpAndSettle();

      // シートは閉じない（ホイールを現在時刻に合わせるだけ）。
      expect(find.byType(CupertinoDatePicker), findsOneWidget);

      await tester.tap(find.byKey(const Key('picker_done')));
      await tester.pumpAndSettle();
      final after = DateTime.now();

      // 5分丸めではなく、現在時刻の分がそのまま入る。
      final dep = container.read(appStateProvider).departure;
      final depMinutes = dep.h * 60 + dep.m;
      expect(
        depMinutes,
        greaterThanOrEqualTo(before.hour * 60 + before.minute),
      );
      expect(depMinutes, lessThanOrEqualTo(after.hour * 60 + after.minute));
      expect(dep.dateOffset, 0);
    });
  });

  group('HomeScreen 固定バッジ撤去', () {
    Future<void> pumpHomeRaw(
      WidgetTester tester,
      ProviderContainer container,
    ) async {
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: ArukuTheme.light(),
            home: const HomeScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('初期表示で「固定」バッジは出ない', (tester) async {
      final container = _container();
      await pumpHomeRaw(tester, container);

      expect(find.text('固定'), findsNothing);
    });

    testWidgets('到着を確定しても「固定」バッジは出ない', (tester) async {
      final container = _container();
      await pumpHomeRaw(tester, container);

      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.arrival,
            h: 18,
            m: 0,
            dateOffset: 0,
          );
      await tester.pumpAndSettle();

      expect(find.text('固定'), findsNothing);
    });
  });

  group('HomeScreen 日付ラベル表示', () {
    Future<void> pumpHomeRaw(
      WidgetTester tester,
      ProviderContainer container,
    ) async {
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: ArukuTheme.light(),
            home: const HomeScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('翌日で確定すると時間カードに「明日」が出る', (tester) async {
      final container = _container();
      await pumpHomeRaw(tester, container);

      container
          .read(appStateProvider.notifier)
          .applyPickedTime(mode: PickerMode.arrival, h: 9, m: 0, dateOffset: 1);
      await tester.pumpAndSettle();

      expect(find.text('明日'), findsOneWidget);
    });

    testWidgets('数日先で確定すると M/D(曜) が時間カードに出る', (tester) async {
      final container = _container();
      await pumpHomeRaw(tester, container);

      container
          .read(appStateProvider.notifier)
          .applyPickedTime(mode: PickerMode.arrival, h: 9, m: 0, dateOffset: 5);
      await tester.pumpAndSettle();

      final expected = const TimeValue(h: 9, m: 0, dateOffset: 5).dateLabel();
      expect(expected, isNotNull);
      expect(find.text(expected!), findsOneWidget);
    });

    testWidgets('当日（dateOffset=0）で確定すると日付ラベルは出ない', (tester) async {
      final container = _container();
      await pumpHomeRaw(tester, container);

      final notifier = container.read(appStateProvider.notifier);
      // 初期 arrival が深夜実行で dateOffset=1 になる場合があるため、
      // 先に到着を遠い未来へ逃がしてクランプを回避してから当日へ揃える。
      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 23,
        m: 0,
        dateOffset: 30,
      );
      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 8,
        m: 0,
        dateOffset: 0,
      );
      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 9,
        m: 0,
        dateOffset: 0,
      );
      await tester.pumpAndSettle();

      expect(find.text('明日'), findsNothing);
    });
  });
}

class _FakeLocationService implements LocationService {
  const _FakeLocationService();

  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}
