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

    test('下2桁を分、それ以上を時とみなす', () {
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
      expect(stepTotalMinutes(9 * 60 + 30, kTimeStepMinutes), 9 * 60 + 35);
    });

    test('刻みぶん戻す', () {
      expect(stepTotalMinutes(9 * 60 + 30, -kTimeStepMinutes), 9 * 60 + 25);
    });

    // 端で止めると 23:58 から上へ動かせない行き止まりになる。折り返して
    // 次の操作が必ず効くようにする。
    test('日の終わりを越えたら先頭へ折り返す', () {
      expect(stepTotalMinutes(23 * 60 + 58, kTimeStepMinutes), 3);
    });

    test('日の始まりより前は末尾へ折り返す', () {
      expect(stepTotalMinutes(2, -kTimeStepMinutes), 23 * 60 + 57);
    });
  });
}
