import 'package:aruku/core/services/cancellation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('CancellationToken', () {
    test('初期状態は未キャンセルで throwIfCanceled が通る', () {
      final token = CancellationToken();
      expect(token.isCanceled, isFalse);
      expect(token.throwIfCanceled, returnsNormally);
    });

    test('cancel すると isCanceled が立ち throwIfCanceled が投げる', () {
      final token = CancellationToken()..cancel();
      expect(token.isCanceled, isTrue);
      expect(token.throwIfCanceled, throwsA(isA<SearchCanceledException>()));
    });

    test('登録済みのコールバックは cancel で発火する', () {
      final token = CancellationToken();
      var fired = 0;
      token.onCancel(() => fired++);
      expect(fired, 0);

      token.cancel();
      expect(fired, 1);
    });

    test('複数のコールバックが登録順に全て発火する', () {
      final token = CancellationToken();
      final order = <String>[];
      token
        ..onCancel(() => order.add('a'))
        ..onCancel(() => order.add('b'))
        ..cancel();
      expect(order, ['a', 'b']);
    });

    test('cancel 済みトークンへの onCancel は即座に発火する', () {
      final token = CancellationToken()..cancel();
      var fired = 0;
      token.onCancel(() => fired++);
      expect(fired, 1);
    });

    test('cancel は冪等でコールバックを二度発火しない', () {
      final token = CancellationToken();
      var fired = 0;
      token
        ..onCancel(() => fired++)
        ..cancel()
        ..cancel();
      expect(fired, 1);
    });
  });
}
