import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
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
    testWidgets('出発フィールドのタップで日付ピッカーが開く', (tester) async {
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

      // 出発フィールドの sub テキスト「今すぐ」は出発フィールド内で一意。
      await tester.tap(find.text('今すぐ'));
      await tester.pumpAndSettle();

      expect(find.byType(DatePickerDialog), findsOneWidget);
    });
  });
}

class _FakeLocationService implements LocationService {
  const _FakeLocationService();

  @override
  Future<LocationState> request() async => const LocationDenied();
}
