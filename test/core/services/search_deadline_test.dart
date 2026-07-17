import 'package:aruku/core/services/search_deadline.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SearchDeadline', () {
    test('経過が予算未満なら残予算を返し、期限切れにならない', () {
      var elapsed = const Duration(seconds: 30);
      final deadline = SearchDeadline(
        const Duration(seconds: 120),
        elapsed: () => elapsed,
      );

      expect(deadline.remaining, const Duration(seconds: 90));
      expect(deadline.isExpired, isFalse);

      elapsed = const Duration(seconds: 119);
      expect(deadline.remaining, const Duration(seconds: 1));
      expect(deadline.isExpired, isFalse);
    });

    test('経過が予算ちょうどで期限切れになる', () {
      final deadline = SearchDeadline(
        const Duration(seconds: 120),
        elapsed: () => const Duration(seconds: 120),
      );

      expect(deadline.remaining, Duration.zero);
      expect(deadline.isExpired, isTrue);
    });

    test('予算超過でも残予算は負にならない', () {
      final deadline = SearchDeadline(
        const Duration(seconds: 120),
        elapsed: () => const Duration(seconds: 500),
      );

      expect(deadline.remaining, Duration.zero);
      expect(deadline.isExpired, isTrue);
    });

    test('既定の経過は実時間で進む', () async {
      final deadline = SearchDeadline(const Duration(seconds: 120));

      expect(
        deadline.remaining,
        lessThanOrEqualTo(const Duration(seconds: 120)),
      );
      final first = deadline.remaining!;
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(deadline.remaining!, lessThan(first));
      expect(deadline.isExpired, isFalse);
    });

    test('無期限の締切は期限切れにならず残予算を持たない', () {
      const deadline = SearchDeadline.none();

      expect(deadline.isExpired, isFalse);
      expect(deadline.remaining, isNull);
    });
  });
}
