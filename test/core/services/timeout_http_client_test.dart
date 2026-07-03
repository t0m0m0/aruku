import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/services/timeout_http_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

/// 応答までの遅延と close 呼び出しを制御できる内側クライアント。
class _FakeInnerClient extends http.BaseClient {
  _FakeInnerClient({this.delay = Duration.zero});

  final Duration delay;
  bool closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (delay > Duration.zero) await Future<void>.delayed(delay);
    return http.StreamedResponse(
      Stream.value(utf8.encode('ok')),
      200,
      request: request,
    );
  }

  @override
  void close() => closed = true;
}

http.Request _request() =>
    http.Request('GET', Uri.parse('https://example.com/x'));

void main() {
  group('TimeoutHttpClient.send', () {
    test('内側が制限時間内に応答すればそのまま透過する', () async {
      final client = TimeoutHttpClient(
        _FakeInnerClient(),
        timeout: const Duration(seconds: 5),
      );

      final response = await client.send(_request());

      expect(response.statusCode, 200);
    });

    test('内側が制限時間を超えると TimeoutException を投げる', () async {
      final client = TimeoutHttpClient(
        _FakeInnerClient(delay: const Duration(milliseconds: 200)),
        timeout: const Duration(milliseconds: 20),
      );

      expect(() => client.send(_request()), throwsA(isA<TimeoutException>()));
    });

    test('既定のタイムアウトは 15 秒', () {
      expect(
        TimeoutHttpClient(_FakeInnerClient()).timeout,
        const Duration(seconds: 15),
      );
    });
  });

  group('TimeoutHttpClient.close', () {
    test('close() が内側クライアントへ委譲される', () {
      final inner = _FakeInnerClient();
      final client = TimeoutHttpClient(inner);

      client.close();

      expect(inner.closed, isTrue);
    });
  });
}
