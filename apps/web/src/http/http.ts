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

/// 1要求ぶんの付帯情報。
///
/// [signal] は要求単位の中止（#488）。クライアント全体を落とす `close()` とは別で、
/// 倒しても同じクライアントの他の要求や以後の要求には効かない。地点検索の typeahead
/// のように、クライアントを画面寿命で使い回しつつ古い要求だけを捨てたい呼び出し側が使う。
export interface RequestOptions {
  readonly signal?: AbortSignal;
}

/// エンジンの [HttpClient] に要求単位の中止を足した契約。web 側の層だけが満たす。
///
/// エンジンの契約そのものへ足していないのは、経路検索の中止が「検索1回ぶんの client を
/// close する」意味論で組まれており（http-client.ts の注記）、エンジンに要求単位の
/// 中止を使う呼び出しが無いため。
export interface AbortableHttpClient extends HttpClient {
  get(url: URL, options?: RequestOptions): Promise<HttpResponse>;
}

/// デコレータを積める HTTP クライアントの基底。Dart の `http.BaseClient` に対応し、
/// エンジンが呼ぶ [get] を [send] の上に実装する。
///
/// ヘッダを引数で下へ流すのは、Dart 側が `request.headers[...] = token` と可変の
/// リクエストオブジェクトを共有していた面（`AppCheckHttpClient.send`）の代わり。
export abstract class BaseHttpClient implements AbortableHttpClient {
  abstract send(
    url: URL,
    headers: HttpHeaders,
    options?: RequestOptions,
  ): Promise<StreamedResponse>;

  abstract close(): void;

  async get(url: URL, options: RequestOptions = {}): Promise<HttpResponse> {
    const response = await this.send(url, {}, options);
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
