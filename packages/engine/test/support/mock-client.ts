// 移植元: package:http/testing の `MockClient`。

import type { HttpClient, HttpResponse } from '../../src/services/http-client';

/// Dart の `http.Response(jsonEncode(body), status)` に対応する。
export function jsonResponse(body: unknown, statusCode = 200): HttpResponse {
  return {
    statusCode,
    bodyBytes: new TextEncoder().encode(JSON.stringify(body)),
  };
}

/// Dart の `MockClient((req) async => res)` に対応する。ハンドラは URL だけを受ける
/// ——エンジンは `client.get(uri)` しか呼ばず、メソッド・ヘッダ・ボディを見ないため。
///
/// `close` は Dart の `MockClient` と同じく no-op。close 回数を観測したいテストは
/// 専用の fake を持つ（移植元も同じ理由で `_CountingClient` を書いている）。
export function mockClient(
  handler: (url: URL) => HttpResponse | Promise<HttpResponse>,
): HttpClient {
  return {
    get: (url) => Promise.resolve(handler(url)),
    close: () => {},
  };
}
