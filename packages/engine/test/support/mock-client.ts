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
    // `async` にするのは、ハンドラが**同期的に**投げるテスト（TIMEOUT・キャンセル・
    // ClientException）があるため。`Promise.resolve(handler(url))` だと throw が
    // `Promise.resolve` より先に抜けて `get` 自体が同期例外になり、`.catch()` や
    // `Promise.all` を経由する実装をすり抜ける。移植元の
    // `MockClient((req) async => throw ...)` は常に**拒否された Future** を返す。
    //
    // ハンドラを呼ぶ前に1マイクロタスク譲るのは、移植元の `MockClient.send` が
    // `await bodyStream.toBytes()` を挟んでからハンドラへ入るため（http 1.6.0）。
    // ここを同期で呼ぶと、**呼び出し側が最初の await に達する前にハンドラの副作用が
    // 見える**——締切のテストは「何本発行されたか」で残予算を決めるので、到着アンカー
    // 第2波（#376）の1本が departure 波の残予算の読み取りより先に数えられ、必須の
    // 初回照会が TIMEOUT で落ちる。fake の同期性が本体の分岐を変えてしまう。
    get: async (url) => {
      await Promise.resolve();
      return handler(url);
    },
    close: () => {},
  };
}
