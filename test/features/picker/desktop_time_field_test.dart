import 'package:aruku/core/models/time_value.dart';
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

String? _dateLabel(WidgetTester tester) => tester
    .widget<Text>(find.byKey(const Key('desktop-date-label-depart')))
    .data;

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

  // 日付を据え置いたまま時刻だけ折り返すと、23:58 の5分後が「同日の 00:03」に
  // なる。到着が翌日のままなら1時間の予算が25時間近くへ膨らむ。
  testWidgets('真夜中をまたぐステップは日付も翌日へ進める', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _type(tester, _departField, '23:58');

    final before = container.read(appStateProvider).departure.dateOffset;
    await tester.tap(find.byKey(_departStepUp));
    await tester.pump();

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m), (0, 3));
    expect(dep.dateOffset, before + 1);
  });

  // 今日より前は選べない。折り返して同日 23:57 にすると、5分戻したつもりが
  // 24時間近く後ろへ飛ぶ。
  testWidgets('今日の 00:02 から戻すステップは効かない', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _type(tester, _departField, '00:02');
    final before = container.read(appStateProvider).departure;

    await tester.tap(find.byKey(_departStepDown));
    await tester.pump();

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m, dep.dateOffset), (before.h, before.m, 0));
  });

  // ホイールシートは下限を now に置いて選ばせない。キー入力は任意の値が来る。
  testWidgets('今日の過去時刻を打つと現在時刻へ引き上げる', (tester) async {
    final container = await _pumpHome(tester, 1280);

    await _type(tester, _departField, '08:00');

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m), (9, 30));
  });

  testWidgets('明日以降なら現在時刻より前でも打てる', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await tester.tap(find.byKey(const Key('desktop-date-step-up-depart')));
    await tester.pump();

    await _type(tester, _departField, '08:00');

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m, dep.dateOffset), (8, 0, 1));
  });

  // 確定値から動かすと、打ったばかりの値が黙って捨てられる。
  testWidgets('確定前の表示値を基点にステップする', (tester) async {
    final container = await _pumpHome(tester, 1280);
    await _type(tester, _departField, '10:00');

    await tester.tap(find.byKey(_departField));
    await tester.pump();
    await tester.enterText(find.byKey(_departField), '11:00');
    await tester.pump();
    await tester.tap(find.byKey(_departStepUp));
    await tester.pump();

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m), (11, 5));
  });

  // 日付ステッパーでは作れない 91 日目を、時刻側の折り返しから作らせない。
  testWidgets('上限の日で真夜中を越えるステップは効かない', (tester) async {
    final container = await _pumpHome(tester, 1280);
    container
        .read(appStateProvider.notifier)
        .applyPickedTime(
          mode: PickerMode.depart,
          h: 23,
          m: 58,
          dateOffset: kMaxDateOffsetDays,
        );
    await tester.pump();

    await tester.tap(find.byKey(_departStepUp));
    await tester.pump();

    final dep = container.read(appStateProvider).departure;
    expect((dep.h, dep.m, dep.dateOffset), (23, 58, kMaxDateOffsetDays));
  });

  testWidgets('ステッパーは読み上げラベルを持つ', (tester) async {
    await _pumpHome(tester, 1280);

    expect(find.bySemanticsLabel('出発を5分あとにする'), findsOneWidget);
    expect(find.bySemanticsLabel('出発を5分まえにする'), findsOneWidget);
    expect(find.bySemanticsLabel('次の日へ'), findsWidgets);
    expect(find.bySemanticsLabel('前の日へ'), findsWidgets);
  });

  group('日付', () {
    testWidgets('既定は今日と表示する', (tester) async {
      await _pumpHome(tester, 1280);
      expect(_dateLabel(tester), '今日');
    });

    testWidgets('日付ステッパーで翌日以降を選べる', (tester) async {
      final container = await _pumpHome(tester, 1280);

      await tester.tap(find.byKey(const Key('desktop-date-step-up-depart')));
      await tester.pump();

      expect(container.read(appStateProvider).departure.dateOffset, 1);
      expect(_dateLabel(tester), '明日');
    });

    testWidgets('今日より前へは動かない', (tester) async {
      final container = await _pumpHome(tester, 1280);

      await tester.tap(find.byKey(const Key('desktop-date-step-down-depart')));
      await tester.pump();

      expect(container.read(appStateProvider).departure.dateOffset, 0);
    });

    testWidgets('上限を越えて先へは動かない', (tester) async {
      final container = await _pumpHome(tester, 1280);
      final up = find.byKey(const Key('desktop-date-step-up-depart'));

      for (var i = 0; i < kMaxDateOffsetDays + 3; i++) {
        await tester.tap(up);
        await tester.pump();
      }

      expect(
        container.read(appStateProvider).departure.dateOffset,
        kMaxDateOffsetDays,
      );
    });
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
