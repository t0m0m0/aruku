import 'package:aruku/features/picker/time_field_input.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('parseTimeInput', () {
    test('HH:MM をそのまま解釈する', () {
      expect(parseTimeInput('09:32'), (h: 9, m: 32));
    });

    test('区切りの有無や種類に関わらず同じ結果になる', () {
      expect(parseTimeInput('0932'), (h: 9, m: 32));
      expect(parseTimeInput('9:32'), (h: 9, m: 32));
      expect(parseTimeInput('9時32分'), (h: 9, m: 32));
      expect(parseTimeInput('  09 : 32 '), (h: 9, m: 32));
    });

    // 区切りがあるなら、それが時と分の境界。下2桁規則を先に当てると
    // `12:3` が 01:23 になり、打ち終える前の値が別の時刻として確定する。
    test('区切りがあるときは1桁の分もそのまま分として読む', () {
      expect(parseTimeInput('12:3'), (h: 12, m: 3));
      expect(parseTimeInput('9:3'), (h: 9, m: 3));
      expect(parseTimeInput('9時5分'), (h: 9, m: 5));
    });

    test('区切りの後ろに数字が無ければ下2桁規則へ戻す', () {
      expect(parseTimeInput('12:'), (h: 0, m: 12));
    });

    test('区切りが無いときは下2桁を分、それ以上を時とみなす', () {
      expect(parseTimeInput('932'), (h: 9, m: 32));
      expect(parseTimeInput('32'), (h: 0, m: 32));
      expect(parseTimeInput('5'), (h: 0, m: 5));
    });

    test('時は 23、分は 59 でクランプする', () {
      expect(parseTimeInput('99:99'), (h: 23, m: 59));
      expect(parseTimeInput('2460'), (h: 23, m: 59));
      expect(parseTimeInput('2559'), (h: 23, m: 59));
    });

    test('数字が1つも無ければ解釈しない', () {
      expect(parseTimeInput(''), isNull);
      expect(parseTimeInput('--:--'), isNull);
      expect(parseTimeInput('あ'), isNull);
    });
  });

  group('stepTotalMinutes', () {
    test('刻みぶん進める', () {
      expect(stepTotalMinutes(9 * 60 + 30, kTimeStepMinutes), (
        totalMinutes: 9 * 60 + 35,
        dayDelta: 0,
      ));
    });

    test('刻みぶん戻す', () {
      expect(stepTotalMinutes(9 * 60 + 30, -kTimeStepMinutes), (
        totalMinutes: 9 * 60 + 25,
        dayDelta: 0,
      ));
    });

    // 時刻だけ折り返して日付を据え置くと、23:58 の5分後が「同日の 00:03」に
    // なる。到着が翌日のままなら1時間の予算が25時間近くへ膨らむ。
    test('日の終わりを越えたら翌日として返す', () {
      expect(stepTotalMinutes(23 * 60 + 58, kTimeStepMinutes), (
        totalMinutes: 3,
        dayDelta: 1,
      ));
    });

    test('日の始まりより前は前日として返す', () {
      expect(stepTotalMinutes(2, -kTimeStepMinutes), (
        totalMinutes: 23 * 60 + 57,
        dayDelta: -1,
      ));
    });
  });
}
