import 'package:aruku/core/state/app_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../e2e/support/e2e_helpers.dart';

const _departField = Key('desktop-time-input-depart');
const _arrivalField = Key('desktop-time-input-arrival');
const _departStepUp = Key('desktop-time-step-up-depart');
const _departStepDown = Key('desktop-time-step-down-depart');

DateTime _fixedNow() => DateTime(2026, 5, 15, 9, 30);

Future<ProviderContainer> _pumpHome(WidgetTester tester, double width) async {
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final container = await makeContainer(now: _fixedNow);
  addTearDown(container.dispose);
  await tester.pumpWidget(appWidget(container));
  await pumpTransition(tester);
  return container;
}

Future<void> _type(WidgetTester tester, Key field, String text) async {
  await tester.tap(find.byKey(field));
  await tester.pump();
  await tester.enterText(find.byKey(field), text);
  await tester.testTextInput.receiveAction(TextInputAction.done);
  await tester.pump();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('モバイル幅ではキー入力フィールドを出さない', (tester) async {
    await _pumpHome(tester, 819);

    expect(find.byKey(_departField), findsNothing);
    expect(find.byKey(const Key('time_field_depart')), findsOneWidget);
  });

  testWidgets('デスクトップ幅ではホイールシートでなくキー入力フィールドを出す', (tester) async {
    await _pumpHome(tester, 1280);

    expect(find.byKey(_departField), findsOneWidget);
    expect(find.byKey(_arrivalField), findsOneWidget);
    expect(find.byKey(const Key('time_field_depart')), findsNothing);
  });

  testWidgets('HH:MM を入力して確定すると出発時刻が変わる', (tester) async {
    final container = await _pumpHome(tester, 1280);

    await _type(tester, _departField, '10:45');

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m), (10, 45));
  });

  testWidgets('区切りなしの入力も同じ規則で解釈する', (tester) async {
    final container = await _pumpHome(tester, 1280);

    await _type(tester, _departField, '1105');

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m), (11, 5));
  });

  testWidgets('範囲外の入力は 23:59 へクランプする', (tester) async {
    final container = await _pumpHome(tester, 1280);

    await _type(tester, _departField, '99:99');

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m), (23, 59));
  });

  testWidgets('ステッパーで5分ずつ動く', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _type(tester, _departField, '10:00');

    await tester.tap(find.byKey(_departStepUp));
    await tester.pump();
    expect(container.read(appStateProvider).departure.m, 5);

    await tester.tap(find.byKey(_departStepDown));
    await tester.pump();
    await tester.tap(find.byKey(_departStepDown));
    await tester.pump();
    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m), (9, 55));
  });

  testWidgets('↑↓ キーでも5分ずつ動く', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _type(tester, _departField, '10:00');

    await tester.tap(find.byKey(_departField));
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    expect(container.read(appStateProvider).departure.m, 5);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(container.read(appStateProvider).departure.m, 0);
  });

  // 到着が出発を追い越さない不変条件は applyPickedTime が持っている。
  // 新しい入力経路がそこを通っていることを画面から確かめる。
  testWidgets('出発より前の到着は出発の後ろへ補正される', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _type(tester, _departField, '10:00');

    await _type(tester, _arrivalField, '09:00');

    final state = container.read(appStateProvider);
    expect(
      state.arrival.totalMinutes,
      greaterThan(state.departure.totalMinutes),
    );
  });
}
