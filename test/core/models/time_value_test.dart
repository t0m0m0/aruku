import 'package:aruku/core/models/time_value.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('TimeValue', () {
    test('dateOffset のデフォルトは 0（今日）', () {
      const tv = TimeValue(h: 9, m: 0);
      expect(tv.dateOffset, 0);
    });

    test('dateOffset=1 で明日を指定できる', () {
      const tv = TimeValue(h: 9, m: 0, dateOffset: 1);
      expect(tv.dateOffset, 1);
    });

    test('dateOffset は 1 より大きい任意の日数を指定できる', () {
      const tv = TimeValue(h: 9, m: 0, dateOffset: 30);
      expect(tv.dateOffset, 30);
    });

    test('dateOffset が負の場合は assert で弾かれる', () {
      expect(
        () => TimeValue(h: 9, m: 0, dateOffset: -1),
        throwsA(isA<AssertionError>()),
      );
    });

    test('copyWith で dateOffset を変更できる', () {
      const tv = TimeValue(h: 9, m: 0, dateOffset: 0);
      final tomorrow = tv.copyWith(dateOffset: 1);
      expect(tomorrow.dateOffset, 1);
      expect(tomorrow.h, 9);
      expect(tomorrow.m, 0);
    });

    test('copyWith で他フィールドを変更しても dateOffset は引き継がれる', () {
      const tv = TimeValue(h: 9, m: 0, dateOffset: 1);
      final updated = tv.copyWith(h: 10);
      expect(updated.dateOffset, 1);
    });

    test('isNow=true の場合 dateOffset は無視される（値は保持）', () {
      const tv = TimeValue(h: 0, m: 0, isNow: true, dateOffset: 0);
      expect(tv.isNow, true);
      expect(tv.dateOffset, 0);
    });
  });

  group('TimeValue.fullDateLabel', () {
    final now = DateTime(2026, 5, 19); // 火曜日

    test('当日（dateOffset=0）は「M月D日 (曜)」', () {
      const tv = TimeValue(h: 8, m: 0, dateOffset: 0);
      expect(tv.fullDateLabel(now: now), '5月19日 (火)');
    });

    test('isNow=true は dateOffset を無視して当日', () {
      const tv = TimeValue(h: 8, m: 0, isNow: true, dateOffset: 3);
      expect(tv.fullDateLabel(now: now), '5月19日 (火)');
    });

    test('翌日（dateOffset=1）は翌日の日付', () {
      const tv = TimeValue(h: 8, m: 0, dateOffset: 1);
      expect(tv.fullDateLabel(now: now), '5月20日 (水)');
    });

    test('月をまたぐ dateOffset も正しく算出', () {
      const tv = TimeValue(h: 9, m: 0, dateOffset: 30);
      expect(tv.fullDateLabel(now: now), '6月18日 (木)');
    });
  });

  group('TimeValue.formatBudget', () {
    test('60分未満は「分」のみ', () {
      expect(TimeValue.formatBudget(45), '45分');
    });

    test('60分以上は「時間」と「分」（分は2桁ゼロ埋め）', () {
      expect(TimeValue.formatBudget(90), '1時間 30分');
    });

    test('ちょうど時間単位でも分は2桁で表示', () {
      expect(TimeValue.formatBudget(120), '2時間 00分');
    });

    test('0以下はプレースホルダ', () {
      expect(TimeValue.formatBudget(0), '— ');
    });
  });

  group('TimeValue.dateLabel', () {
    final now = DateTime(2026, 5, 19); // 火曜日

    test('isNow=true は null（「今すぐ」なので日付不要）', () {
      const tv = TimeValue(h: 8, m: 0, isNow: true, dateOffset: 3);
      expect(tv.dateLabel(now: now), isNull);
    });

    test('当日（dateOffset=0）は null（非表示）', () {
      const tv = TimeValue(h: 8, m: 0, dateOffset: 0);
      expect(tv.dateLabel(now: now), isNull);
    });

    test('翌日（dateOffset=1）は「明日」', () {
      const tv = TimeValue(h: 8, m: 0, dateOffset: 1);
      expect(tv.dateLabel(now: now), '明日');
    });

    test('2日先は M/D(曜) 形式', () {
      const tv = TimeValue(h: 8, m: 0, dateOffset: 2);
      expect(tv.dateLabel(now: now), '5/21(木)');
    });

    test('数日先は M/D(曜) 形式（曜日は月〜日で算出）', () {
      const tv = TimeValue(h: 9, m: 0, dateOffset: 5);
      expect(tv.dateLabel(now: now), '5/24(日)');
    });

    test('月をまたぐ dateOffset も正しく算出', () {
      const tv = TimeValue(h: 9, m: 0, dateOffset: 30);
      expect(tv.dateLabel(now: now), '6/18(木)');
    });
  });

  group('dateOffsetFrom', () {
    final now = DateTime(2026, 5, 19, 14, 30);

    test('同じ日は 0', () {
      expect(dateOffsetFrom(picked: DateTime(2026, 5, 19), now: now), 0);
    });

    test('時刻が残っていても日付だけで数える', () {
      expect(dateOffsetFrom(picked: DateTime(2026, 5, 20, 3, 15), now: now), 1);
    });

    test('月をまたいでも日数で数える', () {
      expect(dateOffsetFrom(picked: DateTime(2026, 6, 18), now: now), 30);
    });

    test('上限の日は kMaxDateOffsetDays', () {
      final last = DateTime(2026, 5, 19 + kMaxDateOffsetDays);
      expect(dateOffsetFrom(picked: last, now: now), kMaxDateOffsetDays);
    });

    // TimeValue は dateOffset >= 0 を assert する。範囲外を素通しすると
    // 画面ではなくモデルの構築時に落ちる。
    test('過去の日付は 0 へ丸める', () {
      expect(dateOffsetFrom(picked: DateTime(2026, 5, 18), now: now), 0);
    });

    test('上限より先の日付は kMaxDateOffsetDays へ丸める', () {
      final beyond = DateTime(2026, 5, 19 + kMaxDateOffsetDays + 5);
      expect(dateOffsetFrom(picked: beyond, now: now), kMaxDateOffsetDays);
    });

    // 押し出された到着は kMaxDateOffsetDays を越えて存在し得る。それを出した
    // 入口が既定で数え直すと、表示した日を選んだだけで別の日へ丸められる。
    test('maxOffset を渡すとその上限で丸める', () {
      final beyond = DateTime(2026, 5, 19 + kMaxDateOffsetDays + 5);
      expect(
        dateOffsetFrom(
          picked: beyond,
          now: now,
          maxOffset: kMaxDateOffsetDays + 1,
        ),
        kMaxDateOffsetDays + 1,
      );
    });
  });
}
