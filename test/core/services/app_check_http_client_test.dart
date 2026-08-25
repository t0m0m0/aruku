import 'dart:convert';

import 'package:aruku/core/services/app_check_http_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

/// send されたリクエストと close 呼び出しを記録する内側クライアント。
class _FakeInnerClient extends http.BaseClient {
  http.BaseRequest? lastRequest;
  bool closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    lastRequest = request;
    return http.StreamedResponse(
      Stream.value(utf8.encode('ok')),
      200,
      request: request,
    );
  }

  @override
  void close() => closed = true;
}

http.Request _request([String path = 'placesProxy']) =>
    http.Request('GET', Uri.parse('https://proxy.example.com/$path'));

void main() {
  group('AppCheckHttpClient.send', () {
    test('トークン取得成功時に X-Firebase-AppCheck ヘッダが付与される', () async {
      final inner = _FakeInnerClient();
      final client = AppCheckHttpClient(
        inner,
        limitedUseTokenProvider: () async => 'token_abc',
      );

      await client.send(_request());

      expect(inner.lastRequest, isNotNull);
      expect(inner.lastRequest!.headers['X-Firebase-AppCheck'], 'token_abc');
    });

    test('getLimitedUseToken が例外を投げてもヘッダ未付与でリクエストは継続する', () async {
      final inner = _FakeInnerClient();
      final client = AppCheckHttpClient(
        inner,
        limitedUseTokenProvider: () async => throw Exception('App Check 未設定'),
      );

      final response = await client.send(_request());

      // 例外を握りつぶし、ヘッダ無しで内側へ転送されること
      expect(inner.lastRequest, isNotNull);
      expect(
        inner.lastRequest!.headers.containsKey('X-Firebase-AppCheck'),
        isFalse,
      );
      expect(response.statusCode, 200);
    });

    test('トークンが null の場合はヘッダを付与しない', () async {
      final inner = _FakeInnerClient();
      final client = AppCheckHttpClient(
        inner,
        limitedUseTokenProvider: () async => null,
      );

      await client.send(_request());

      expect(
        inner.lastRequest!.headers.containsKey('X-Firebase-AppCheck'),
        isFalse,
      );
    });

    test('トークンが空文字列の場合はヘッダを付与しない', () async {
      final inner = _FakeInnerClient();
      final client = AppCheckHttpClient(
        inner,
        limitedUseTokenProvider: () async => '',
      );

      await client.send(_request());

      expect(
        inner.lastRequest!.headers.containsKey('X-Firebase-AppCheck'),
        isFalse,
      );
    });
  });

  group('limited-use トークン（リプレイ保護, issue #155・#366）', () {
    // このクライアントが触る URL は課金プロキシ3本だけで、いずれもサーバ側が
    // consume:true で検証する。標準トークンを送る経路が1つでも残ると、そこは
    // 2 回目以降 401 になる。
    for (final path in const [
      'placesProxy',
      'googleWalkProxy',
      'googleWalkMatrixProxy',
    ]) {
      test('$path へは limited-use プロバイダのトークンを付与する', () async {
        final inner = _FakeInnerClient();
        final client = AppCheckHttpClient(
          inner,
          limitedUseTokenProvider: () async => 'limited_use_token',
        );

        await client.send(_request(path));

        expect(
          inner.lastRequest!.headers['X-Firebase-AppCheck'],
          'limited_use_token',
        );
      });
    }
  });

  group('AppCheckHttpClient.close', () {
    test('close() が内部クライアントへ委譲される', () {
      final inner = _FakeInnerClient();
      final client = AppCheckHttpClient(
        inner,
        limitedUseTokenProvider: () async => null,
      );

      client.close();

      expect(inner.closed, isTrue);
    });
  });
}
