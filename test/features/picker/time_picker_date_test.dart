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
    test('出発を確定すると departure に値・anchor・dateOffset が入る', () async {
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
      expect(state.departure.anchored, true);
      expect(state.arrival.anchored, false);
    });

    test('到着を確定すると arrival が anchor され departure の anchor が外れる', () async {
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
      expect(state.arrival.anchored, true);
      expect(state.departure.anchored, false);
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
      // 出発フィールドの sub テキスト「今すぐ」は出発フィールド内で一意。
      await tester.tap(find.text('今すぐ'));
      await tester.pumpAndSettle();
    }

    testWidgets('出発フィールドのタップで連結ホイールと出発/到着タブが開く', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      expect(find.byType(CupertinoDatePicker), findsOneWidget);
      expect(find.byKey(const Key('seg_depart')), findsOneWidget);
      expect(find.byKey(const Key('seg_arrival')), findsOneWidget);
    });

    testWidgets('完了で出発が anchor され到着の anchor が外れる', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      await tester.tap(find.byKey(const Key('picker_done')));
      await tester.pumpAndSettle();

      final state = container.read(appStateProvider);
      expect(find.byType(CupertinoDatePicker), findsNothing);
      expect(state.departure.anchored, true);
      expect(state.arrival.anchored, false);
    });

    testWidgets('到着タブに切替えて完了すると arrival が anchor される', (tester) async {
      final container = _container();
      await pumpHome(tester, container);

      await tester.tap(find.byKey(const Key('seg_arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('picker_done')));
      await tester.pumpAndSettle();

      final state = container.read(appStateProvider);
      expect(state.arrival.anchored, true);
      expect(state.departure.anchored, false);
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

      container
          .read(appStateProvider.notifier)
          .applyPickedTime(mode: PickerMode.depart, h: 8, m: 0, dateOffset: 0);
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
