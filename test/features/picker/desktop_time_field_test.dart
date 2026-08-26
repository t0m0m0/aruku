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
const _departDateOpen = Key('desktop-date-open-depart');

DateTime _fixedNow() => DateTime(2026, 5, 15, 9, 30);

/// 進められる時計。日跨ぎのように、ダイアログ表示中に現在時刻が変わる経路を作る。
class _MovableClock {
  _MovableClock(this._value);

  DateTime _value;

  DateTime call() => _value;

  void set(DateTime value) => _value = value;
}

Future<ProviderContainer> _pumpHome(
  WidgetTester tester,
  double width, {
  DateTime Function()? now,
}) async {
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final container = await makeContainer(now: now ?? _fixedNow);
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

int _budgetMinutes(ProviderContainer container) {
  final state = container.read(appStateProvider);
  int abs(TimeValue t) => t.dateOffset * 24 * 60 + t.totalMinutes;
  return abs(state.arrival) - abs(state.departure);
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

  group('カレンダー', () {
    testWidgets('日付ラベルを押すとカレンダーが開く', (tester) async {
      await _pumpHome(tester, 1280);

      expect(find.byType(DatePickerDialog), findsNothing);
      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();

      expect(find.byType(DatePickerDialog), findsOneWidget);
    });

    testWidgets('選べる範囲は今日から kMaxDateOffsetDays 日後まで', (tester) async {
      await _pumpHome(tester, 1280);
      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();

      final dialog = tester.widget<DatePickerDialog>(
        find.byType(DatePickerDialog),
      );
      final today = DateTime(2026, 5, 15);
      expect(dialog.firstDate, today);
      expect(
        dialog.lastDate,
        today.add(const Duration(days: kMaxDateOffsetDays)),
      );
    });

    testWidgets('カレンダーは日本語で出る', (tester) async {
      await _pumpHome(tester, 1280);
      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();

      expect(find.text('日付の選択'), findsOneWidget);
      expect(find.text('2026年5月'), findsOneWidget);
    });

    testWidgets('選んだ日が dateOffset になる', (tester) async {
      final container = await _pumpHome(tester, 1280);
      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();

      // 固定した現在時刻は 2026-05-15。同月内の 22 日＝今日+7。
      await tester.tap(find.text('22'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      expect(container.read(appStateProvider).departure.dateOffset, 7);
      expect(_dateLabel(tester), '5/22(金)');
    });

    testWidgets('翌月の日付も選べる', (tester) async {
      final container = await _pumpHome(tester, 1280);
      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();

      // 日付ステッパーも同じアイコンを使う。絞らないと「次の日へ」を押す。
      await tester.tap(
        find.descendant(
          of: find.byType(DatePickerDialog),
          matching: find.byIcon(Icons.chevron_right),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('10'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      // 2026-06-10 は今日+26日。
      expect(container.read(appStateProvider).departure.dateOffset, 26);
    });

    testWidgets('キャンセルすると日付は変わらない', (tester) async {
      final container = await _pumpHome(tester, 1280);
      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();

      await tester.tap(find.text('22'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('キャンセル'));
      await tester.pumpAndSettle();

      expect(container.read(appStateProvider).departure.dateOffset, 0);
    });

    testWidgets('今日を選び直しても出発は現在時刻より前にならない', (tester) async {
      final container = await _pumpHome(tester, 1280);
      await tester.tap(find.byKey(const Key('desktop-date-step-up-depart')));
      await tester.pump();
      await _type(tester, _departField, '08:00');

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      await tester.tap(find.text('15'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final dep = container.read(appStateProvider).departure;
      expect((dep.h, dep.m, dep.dateOffset), (9, 30, 0));
    });

    testWidgets('確定前に打った時刻を残したまま日付を変える', (tester) async {
      final container = await _pumpHome(tester, 1280);
      await tester.tap(find.byKey(_departField));
      await tester.pump();
      await tester.enterText(find.byKey(_departField), '18:20');
      await tester.pump();

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      await tester.tap(find.text('22'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final dep = container.read(appStateProvider).departure;
      expect((dep.h, dep.m, dep.dateOffset), (18, 20, 7));
    });

    testWidgets('到着側にもカレンダーの入口がある', (tester) async {
      await _pumpHome(tester, 1280);

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();

      expect(find.byType(DatePickerDialog), findsOneWidget);
    });

    // Text の意味づけは親の Semantics へ併合され、用途と日付が1ノードに並ぶ。
    testWidgets('カレンダーの入口は出発・到着を区別して読み上げる', (tester) async {
      await _pumpHome(tester, 1280);

      expect(find.bySemanticsLabel(RegExp(r'^出発の日付を選ぶ\n今日$')), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp(r'^到着の日付を選ぶ\n今日$')), findsOneWidget);
    });

    testWidgets('上限を越えた到着でもカレンダーは開ける', (tester) async {
      final container = await _pumpHome(tester, 1280);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.depart,
            h: 23,
            m: 59,
            dateOffset: kMaxDateOffsetDays,
          );
      await tester.pump();
      expect(
        container.read(appStateProvider).arrival.dateOffset,
        greaterThan(kMaxDateOffsetDays),
      );

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();

      expect(find.byType(DatePickerDialog), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('到着カレンダーは出発の日より前を出さない', (tester) async {
      await _pumpHome(tester, 1280);
      final up = find.byKey(const Key('desktop-date-step-up-depart'));
      for (var i = 0; i < 3; i++) {
        await tester.tap(up);
        await tester.pump();
      }

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();

      final dialog = tester.widget<DatePickerDialog>(
        find.byType(DatePickerDialog),
      );
      expect(dialog.firstDate, DateTime(2026, 5, 18));
    });

    testWidgets('23:59 出発なら到着カレンダーは翌日から始まる', (tester) async {
      await _pumpHome(tester, 1280, now: () => DateTime(2026, 5, 15, 23, 59));

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();

      final dialog = tester.widget<DatePickerDialog>(
        find.byType(DatePickerDialog),
      );
      expect(dialog.firstDate, DateTime(2026, 5, 16));
    });

    // 09:30 のまま古びた isNow 出発に到着を比べると25時間の予算ができ、
    // startSearch の再取得がそれを保って到着をもう1日先へ送る。
    testWidgets('古びた今すぐ出発でも選んだ到着日がずれない', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 9, 30));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      clock.set(DateTime(2026, 5, 15, 23, 59));

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('16'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final state = container.read(appStateProvider);
      expect(
        (state.departure.h, state.departure.m, state.departure.isNow),
        (23, 59, true),
      );
      expect(
        (state.arrival.h, state.arrival.m, state.arrival.dateOffset),
        (10, 30, 1),
      );
    });

    // 西向きの時刻変更で今日が戻ることがある。据え置くと offset 0 が指す日が
    // 1日手前へずれる。
    testWidgets('今日が手前へ動いたら日付を先へ送り返す', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 16, 10, 0));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(mode: PickerMode.depart, h: 12, m: 0, dateOffset: 0);
      await tester.pump();

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 15, 10, 0));
      await tester.tap(find.text('キャンセル'));
      await tester.pumpAndSettle();

      final dep = container.read(appStateProvider).departure;
      expect((dep.h, dep.m, dep.dateOffset), (12, 0, 1));
    });

    // 幅が 820px を割ると欄は捨てられるが、ダイアログは開いたまま残る。
    testWidgets('欄が外れて閉じても日付は同じ日を指したまま', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(mode: PickerMode.depart, h: 10, m: 0, dateOffset: 1);
      await tester.pump();

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      tester.view.physicalSize = const Size(819, 900);
      await tester.pumpAndSettle();
      expect(find.byKey(_departDateOpen), findsNothing);

      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('キャンセル'));
      await tester.pumpAndSettle();

      final dep = container.read(appStateProvider).departure;
      expect((dep.h, dep.m, dep.dateOffset), (10, 0, 0));
    });

    testWidgets('上限を越えた到着は開いて確定しても動かない', (tester) async {
      final container = await _pumpHome(tester, 1280);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.depart,
            h: 23,
            m: 59,
            dateOffset: kMaxDateOffsetDays,
          );
      await tester.pump();
      final before = container.read(appStateProvider).arrival;

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final after = container.read(appStateProvider).arrival;
      expect(
        (after.h, after.m, after.dateOffset),
        (before.h, before.m, before.dateOffset),
      );
    });

    testWidgets('下限が範囲内でも上限を越えた到着は確定で動かない', (tester) async {
      final container = await _pumpHome(tester, 1280);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.depart,
            h: 23,
            m: 30,
            dateOffset: kMaxDateOffsetDays,
          );
      await tester.pump();
      final before = container.read(appStateProvider).arrival;
      expect(before.dateOffset, greaterThan(kMaxDateOffsetDays));

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final after = container.read(appStateProvider).arrival;
      expect(
        (after.h, after.m, after.dateOffset),
        (before.h, before.m, before.dateOffset),
      );
    });

    testWidgets('過ぎた出発は現在時刻へ寄せ、選んだ到着はその日に残る', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.depart,
            h: 23,
            m: 55,
            dateOffset: 0,
          );
      await tester.pump();
      final before = container.read(appStateProvider).arrival;

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('16'));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final state = container.read(appStateProvider);
      expect(
        (state.arrival.h, state.arrival.m, state.arrival.dateOffset),
        (before.h, before.m, 0),
      );
      expect(
        (state.departure.h, state.departure.m, state.departure.dateOffset),
        (0, 5, 0),
      );
    });

    testWidgets('日を跨ぐと今すぐ出発も跨いだ先の時刻になる', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      final before = container.read(appStateProvider).arrival;
      expect(before.dateOffset, 1);

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('16'));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final state = container.read(appStateProvider);
      expect(
        (state.departure.h, state.departure.m, state.departure.isNow),
        (0, 5, true),
      );
      expect(
        (state.arrival.h, state.arrival.m, state.arrival.dateOffset),
        (before.h, before.m, 0),
      );
    });

    testWidgets('跨いだ先で過ぎている出発も現在時刻へ寄せる', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(mode: PickerMode.depart, h: 0, m: 1, dateOffset: 1);
      await tester.pump();

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('16'));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final dep = container.read(appStateProvider).departure;
      expect((dep.h, dep.m, dep.dateOffset), (0, 5, 0));
    });

    testWidgets('過ぎた出発を寄せても設定した予算幅は縮まない', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.depart,
            h: 23,
            m: 55,
            dateOffset: 0,
          );
      await tester.pump();
      final budget = _budgetMinutes(container);

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      await tester.tap(find.text('16'));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final state = container.read(appStateProvider);
      expect((state.departure.h, state.departure.m), (23, 55));
      expect(_budgetMinutes(container), budget);
    });

    testWidgets('選んだ日が表示中に過ぎたら再基準化した値を残す', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.depart,
            h: 23,
            m: 55,
            dateOffset: 0,
          );
      await tester.pump();

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      await tester.tap(find.text('15'));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final dep = container.read(appStateProvider).departure;
      expect((dep.h, dep.m, dep.dateOffset), (0, 5, 0));
    });

    testWidgets('取り消して閉じても日付は同じ日を指したまま', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(mode: PickerMode.depart, h: 10, m: 0, dateOffset: 1);
      await tester.pump();

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('キャンセル'));
      await tester.pumpAndSettle();

      final dep = container.read(appStateProvider).departure;
      expect((dep.h, dep.m, dep.dateOffset), (10, 0, 0));
    });

    testWidgets('上限を越えて放置された日付も詰めきる', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 0));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.depart,
            h: 23,
            m: 0,
            dateOffset: kMaxDateOffsetDays,
          );
      await tester.pump();

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 15 + kMaxDateOffsetDays + 1, 9, 30));
      await tester.tap(find.text('キャンセル'));
      await tester.pumpAndSettle();

      final dep = container.read(appStateProvider).departure;
      expect((dep.h, dep.m, dep.dateOffset), (9, 30, 0));
    });

    testWidgets('60分の予算は日を跨いだ出発の打ち直しでも保たれる', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      final notifier = container.read(appStateProvider.notifier);
      notifier.applyPickedTime(
        mode: PickerMode.depart,
        h: 23,
        m: 55,
        dateOffset: 0,
      );
      notifier.applyPickedTime(
        mode: PickerMode.arrival,
        h: 0,
        m: 55,
        dateOffset: 1,
      );
      await tester.pump();
      expect(_budgetMinutes(container), 60);

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      await tester.tap(find.text('16'));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      final state = container.read(appStateProvider);
      expect(
        (state.departure.h, state.departure.m, state.departure.dateOffset),
        (23, 55, 0),
      );
      expect(
        (state.arrival.h, state.arrival.m, state.arrival.dateOffset),
        (0, 55, 1),
      );
      expect(_budgetMinutes(container), 60);
    });

    testWidgets('日を跨いで確定しても予算が24時間ぶん伸びない', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);
      await tester.tap(find.byKey(const Key('desktop-date-step-up-depart')));
      await tester.pump();
      final budget = _budgetMinutes(container);

      await tester.tap(find.byKey(_departDateOpen));
      await tester.pumpAndSettle();
      await tester.tap(find.text('16'));
      await tester.pumpAndSettle();
      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      expect(_budgetMinutes(container), budget);
      expect(container.read(appStateProvider).departure.dateOffset, 0);
    });

    // 出発が上限の日の 23:59 だと到着の下限は 91 日目になり、firstDate が
    // lastDate を越える。showDatePicker はその組み合わせでも assert で落ちる。
    testWidgets('出発が上限の日でも到着カレンダーは開ける', (tester) async {
      final container = await _pumpHome(tester, 1280);
      container
          .read(appStateProvider.notifier)
          .applyPickedTime(
            mode: PickerMode.depart,
            h: 23,
            m: 59,
            dateOffset: kMaxDateOffsetDays,
          );
      await tester.pump();

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();

      expect(find.byType(DatePickerDialog), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    // 開いた時点の now で数えると、日を跨いだ瞬間に基準日が古いままになる。
    // 「明日」を選んだのに、確定後の今日から見ると1日先を指す。
    testWidgets('表示中に日付が変わっても選んだ日そのものを指す', (tester) async {
      final clock = _MovableClock(DateTime(2026, 5, 15, 23, 50));
      final container = await _pumpHome(tester, 1280, now: clock.call);

      await tester.tap(find.byKey(const Key('desktop-date-open-arrival')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('16'));
      await tester.pumpAndSettle();

      clock.set(DateTime(2026, 5, 16, 0, 5));
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      // 5月16日は確定した時点の「今日」。1日先ではない。
      expect(container.read(appStateProvider).arrival.dateOffset, 0);
    });

    testWidgets('モバイル幅にはカレンダーの入口を出さない', (tester) async {
      await _pumpHome(tester, 819);

      expect(find.byKey(_departDateOpen), findsNothing);
    });
  });
}
