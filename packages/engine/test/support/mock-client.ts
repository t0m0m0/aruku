// 移植元: package:http/testing の `MockClient`。

import type { HttpClient, HttpResponse } from '../../src/services/http-client';

/// Dart の `http.Response.bytes(utf8.encode(jsonEncode(body)), status)` に対応する。
export function jsonResponse(body: unknown, statusCode = 200): HttpResponse {
  return {
    statusCode,
    bodyBytes: new TextEncoder().encode(JSON.stringify(body)),
  };
}

export interface MockHttpClient extends HttpClient {
  /// [close] が呼ばれた回数。Dart の `MockClient.close()` は no-op で観測できないが、
  /// キャンセル（#259）は close が起点なので、移植先では数えられるようにする。
  readonly closeCount: number;
}

/// Dart の `MockClient((req) async => res)` に対応する。ハンドラは URL だけを受ける
/// ——エンジンは `client.get(uri)` しか呼ばず、メソッド・ヘッダ・ボディを見ないため。
export function mockClient(
  handler: (url: URL) => HttpResponse | Promise<HttpResponse>,
): MockHttpClient {
  let closeCount = 0;
  return {
    get closeCount() {
      return closeCount;
    },
    get: (url) => Promise.resolve(handler(url)),
    close: () => {
      closeCount++;
    },
  };
}
