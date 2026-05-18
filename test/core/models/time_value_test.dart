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
}
