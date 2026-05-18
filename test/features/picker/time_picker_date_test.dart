import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/picker/time_picker_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child, {required ProviderContainer container}) {
  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      theme: ArukuTheme.light(),
      home: Scaffold(body: child),
    ),
  );
}

ProviderContainer _containerWithPicker({
  PickerMode mode = PickerMode.depart,
  int dateOffset = 0,
}) {
  final container = ProviderContainer();
  final notifier = container.read(appStateProvider.notifier);
  notifier.openPicker(mode);
  notifier.updatePicker(dateOffset: dateOffset);
  return container;
}

void main() {
  group('TimePickerSheet 日付チップ', () {
    testWidgets('「今日」「明日」チップが表示される', (tester) async {
      final container = ProviderContainer();
      container.read(appStateProvider.notifier).openPicker(PickerMode.depart);

      await tester.pumpWidget(
        _wrap(const TimePickerSheet(), container: container),
      );
      await tester.pump();

      expect(find.text('今日'), findsOneWidget);
      expect(find.text('明日'), findsOneWidget);
    });

    testWidgets('デフォルトは「今日」がアクティブ', (tester) async {
      final container = ProviderContainer();
      container.read(appStateProvider.notifier).openPicker(PickerMode.depart);

      await tester.pumpWidget(
        _wrap(const TimePickerSheet(), container: container),
      );
      await tester.pump();

      // picker.dateOffset == 0 のはず
      final state = container.read(appStateProvider);
      expect(state.picker?.dateOffset, 0);
    });

    testWidgets('「明日」をタップすると picker.dateOffset が 1 になる', (tester) async {
      final container = ProviderContainer();
      container.read(appStateProvider.notifier).openPicker(PickerMode.depart);

      await tester.pumpWidget(
        _wrap(const TimePickerSheet(), container: container),
      );
      await tester.pump();

      await tester.tap(find.text('明日'));
      await tester.pump();

      final state = container.read(appStateProvider);
      expect(state.picker?.dateOffset, 1);
    });

    testWidgets('「今日」をタップすると picker.dateOffset が 0 に戻る', (tester) async {
      final container = _containerWithPicker(dateOffset: 1);

      await tester.pumpWidget(
        _wrap(const TimePickerSheet(), container: container),
      );
      await tester.pump();

      await tester.tap(find.text('今日'));
      await tester.pump();

      final state = container.read(appStateProvider);
      expect(state.picker?.dateOffset, 0);
    });

    testWidgets('confirmPicker で arrival.dateOffset が picker の値を引き継ぐ', (
      tester,
    ) async {
      final container = ProviderContainer();
      final notifier = container.read(appStateProvider.notifier);
      notifier.openPicker(PickerMode.arrival);
      notifier.updatePicker(dateOffset: 1);

      await tester.pumpWidget(
        _wrap(const TimePickerSheet(), container: container),
      );
      await tester.pump();

      await tester.tap(find.text('この時刻に決定'));
      await tester.pump();

      final state = container.read(appStateProvider);
      expect(state.picker, isNull);
      expect(state.arrival.dateOffset, 1);
    });
  });
}
