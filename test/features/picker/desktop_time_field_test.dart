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

  group('カレンダー', () {
    // 上限は今日+90日。1クリック1日のステッパーだけでは端まで90クリック要り、
    // 遠い日付を選ぶ手段が実質無い。
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

    // 月グリッドが英語で出ると「一般的な形へ寄せる」目的を果たさない。
    // GlobalMaterialLocalizations が外れたら気付けるようにする。
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

      // 日付ステッパーも同じ矢印アイコンを使う。ダイアログ内へ絞らないと
      // 「次の月へ」ではなくフィールド側の「次の日へ」を押す。
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

    // 時刻の下限は applyPickedTime の担当。カレンダーは日付の下限しか表現できず、
    // 今日を選び直した経路でも現在時刻より前に落ちてはいけない。
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

    // 確定値から日付だけ動かすと、打ったばかりの時刻が黙って捨てられる。
    // ステッパーと同じく編集中の表示値を基点にする。
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

    // 矢印と違い日付ラベルは現在値そのものが手掛かりになる。Text の意味づけは
    // 親の Semantics へ併合されるので、用途と日付が1ノードに並ぶ。
    testWidgets('カレンダーの入口は用途と現在の日付を読み上げる', (tester) async {
      await _pumpHome(tester, 1280);

      expect(find.bySemanticsLabel(RegExp(r'^日付を選ぶ\n今日$')), findsWidgets);
    });

    // 到着は出発+最小ギャップへ押し出されるため、出発が上限の日の 23:59 だと
    // 上限を1日越える。カレンダーは initialDate が lastDate を越えると
    // assert で落ちる。ホイールシートは _initialFor で同じ事故を防いでいる。
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

    testWidgets('モバイル幅にはカレンダーの入口を出さない', (tester) async {
      await _pumpHome(tester, 819);

      expect(find.byKey(_departDateOpen), findsNothing);
    });
  });
}
