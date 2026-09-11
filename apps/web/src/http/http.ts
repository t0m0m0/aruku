import type { HttpClient, HttpResponse } from '@aruku/engine/services/http-client';

/// 1リクエストに載せるヘッダ。
export type HttpHeaders = Readonly<Record<string, string>>;

/// ボディを読み切る前のレスポンス。Dart の `http.StreamedResponse` に対応する。
///
/// エンジンの `HttpResponse`（bodyBytes 済み）で層をつながないのは、タイムアウトの
/// 層がボディ受信の chunk 間アイドルにも上限を掛ける必要があるため（#156）。
/// 読み切った後の姿しか渡せないと、ヘッダだけ返してボディ送出でストールする無応答を
/// 内側の層が観測できない。
export interface StreamedResponse {
  readonly statusCode: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

/// デコレータを積める HTTP クライアントの基底。Dart の `http.BaseClient` に対応し、
/// エンジンが呼ぶ [get] を [send] の上に実装する。
///
/// ヘッダを引数で下へ流すのは、Dart 側が `request.headers[...] = token` と可変の
/// リクエストオブジェクトを共有していた面（`AppCheckHttpClient.send`）の代わり。
export abstract class BaseHttpClient implements HttpClient {
  abstract send(url: URL, headers: HttpHeaders): Promise<StreamedResponse>;

  abstract close(): void;

  async get(url: URL): Promise<HttpResponse> {
    const response = await this.send(url, {});
    return {
      statusCode: response.statusCode,
      bodyBytes: await readAllBytes(response.body),
    };
  }
}

async function readAllBytes(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
