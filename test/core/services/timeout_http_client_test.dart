import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/services/app_check_http_client.dart';
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

/// ヘッダは即返すが、ボディの1 chunk 目が [bodyDelay] 後にしか流れない内側
/// クライアント。ヘッダ受信後のボディ送出ストールを再現する。
class _StallingBodyClient extends http.BaseClient {
  _StallingBodyClient({required this.bodyDelay});

  final Duration bodyDelay;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final stream = Stream<List<int>>.fromFuture(
      Future<List<int>>.delayed(bodyDelay, () => utf8.encode('ok')),
    );
    return http.StreamedResponse(stream, 200, request: request);
  }

  @override
  void close() {}
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

    test('ヘッダ受信後のボディ送出ストールも TimeoutException で打ち切る (#156)', () {
      // ヘッダは即返るので send の header タイムアウトでは拾えない。get() が
      // ボディを読み切る際に stream の chunk 間アイドルで打ち切られること。
      final client = TimeoutHttpClient(
        _StallingBodyClient(bodyDelay: const Duration(milliseconds: 200)),
        timeout: const Duration(milliseconds: 20),
      );

      expect(
        () => client.get(Uri.parse('https://example.com/x')),
        throwsA(isA<TimeoutException>()),
      );
    });

    test('内側の App Check トークン取得がハングしても打ち切る (#156)', () {
      // 合成順を TimeoutHttpClient(AppCheckHttpClient(...)) と最外側にすることで、
      // getToken 相当の送信前待ちも header タイムアウトの内側に収まる。
      final client = TimeoutHttpClient(
        AppCheckHttpClient(
          _FakeInnerClient(),
          tokenProvider: () => Future<String?>.delayed(
            const Duration(milliseconds: 200),
            () => 't',
          ),
        ),
        timeout: const Duration(milliseconds: 20),
      );

      expect(
        () => client.get(Uri.parse('https://example.com/x')),
        throwsA(isA<TimeoutException>()),
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
