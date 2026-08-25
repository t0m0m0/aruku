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

// 既定は consume 対象外のパス。ヘッダ付与そのものを見るテストが
// tokenProvider（標準トークン側）の注入を確実に通るようにする。
http.Request _request([String path = 'googleWalkProxy']) =>
    http.Request('GET', Uri.parse('https://proxy.example.com/$path'));

void main() {
  group('AppCheckHttpClient.send', () {
    test('トークン取得成功時に X-Firebase-AppCheck ヘッダが付与される', () async {
      final inner = _FakeInnerClient();
      final client = AppCheckHttpClient(
        inner,
        tokenProvider: () async => 'token_abc',
      );

      await client.send(_request());

      expect(inner.lastRequest, isNotNull);
      expect(inner.lastRequest!.headers['X-Firebase-AppCheck'], 'token_abc');
    });

    test('トークン取得が例外を投げてもヘッダ未付与でリクエストは継続する', () async {
      final inner = _FakeInnerClient();
      final client = AppCheckHttpClient(
        inner,
        tokenProvider: () async => throw Exception('App Check 未設定'),
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
    AppCheckHttpClient build(_FakeInnerClient inner) => AppCheckHttpClient(
      inner,
      tokenProvider: () async => 'standard_token',
      limitedUseTokenProvider: () async => 'limited_use_token',
    );

    // サーバが consume:true で検証するエンドポイントとここは厳密一致させる。
    // 送りすぎ（対象外へ使い捨て）はアテステーション・クォータを無駄に焼き、
    // 送り足りない（対象へ標準）は 2 回目以降 401 で機能を壊す。
    for (final path in const ['placesProxy', 'googleWalkMatrixProxy']) {
      test('$path へは limited-use プロバイダのトークンを付与する', () async {
        final inner = _FakeInnerClient();
        await build(inner).send(_request(path));
        expect(
          inner.lastRequest!.headers['X-Firebase-AppCheck'],
          'limited_use_token',
        );
      });
    }

    // 1検索で 21 本まで膨らむ（spec §3.8）。ここを使い捨てにするとクォータが先に尽き、
    // getLimitedUseToken の失敗＝ヘッダ落ち＝全要求 401 を招く。
    test('googleWalkProxy へは標準プロバイダのトークンを付与する', () async {
      final inner = _FakeInnerClient();
      await build(inner).send(_request('googleWalkProxy'));
      expect(
        inner.lastRequest!.headers['X-Firebase-AppCheck'],
        'standard_token',
      );
    });

    test('requiresLimitedUseToken は consume 対象のみ true', () {
      Uri url(String p) => Uri.parse('https://proxy.example.com/$p');
      expect(
        AppCheckHttpClient.requiresLimitedUseToken(url('placesProxy')),
        isTrue,
      );
      expect(
        AppCheckHttpClient.requiresLimitedUseToken(
          url('googleWalkMatrixProxy'),
        ),
        isTrue,
      );
      expect(
        AppCheckHttpClient.requiresLimitedUseToken(url('googleWalkProxy')),
        isFalse,
      );
    });
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
