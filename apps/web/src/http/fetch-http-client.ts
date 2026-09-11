import { ClientException } from '@aruku/engine/services/http-client';

import { BaseHttpClient, type HttpHeaders, type StreamedResponse } from './http';

/// テストが実ネットワークに触れずに済むよう注入可能にする。
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchHttpClientOptions {
  readonly fetch?: Fetch;
}

/// `fetch` をエンジンの `HttpClient` 契約へ嵌める最内層。Dart の `http.Client()` の位置。
///
/// [close] はクライアント1つぶんの `AbortController` を倒す。検索1回ぶんの寿命で
/// 所有し、離脱時に in-flight のソケットごと落とす設計（#259）の実体がこれ。
export class FetchHttpClient extends BaseHttpClient {
  private readonly fetch: Fetch;
  private readonly aborter = new AbortController();

  constructor(options: FetchHttpClientOptions = {}) {
    super();
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async send(url: URL, headers: HttpHeaders): Promise<StreamedResponse> {
    // 中断済みで発行しないのは Dart の `http.Client` が閉じた後の送信を
    // ClientException で拒むのと同じ。上位から見て「閉じた後は失敗する」が揃う。
    if (this.aborter.signal.aborted) {
      throw new ClientException(`Client is already closed: ${url.href}`);
    }

    let response: Response;
    try {
      response = await this.fetch(url.href, {
        headers,
        signal: this.aborter.signal,
      });
    } catch (error) {
      throw asClientException(error);
    }

    return {
      statusCode: response.status,
      body: response.body === null ? null : rethrowAsClientException(response.body),
    };
  }

  close(): void {
    this.aborter.abort();
  }
}

/// 通信の失敗を `ClientException` へ寄せる。
///
/// 中断（AbortError）も同じ扱いにする。キャンセルは CancellationToken が表現する層で、
/// トランスポートから見れば「閉じられたので倒れた」でしかない——エンジンはこの区別を
/// `cancellation.throwIfCanceled()` で付け直す（transit-api-client.ts の catch）。
/// ここで専用の例外型に分けると、その昇格を通らない経路で意味が二重化する。
function asClientException(error: unknown): ClientException {
  if (error instanceof ClientException) return error;
  return new ClientException(
    error instanceof Error ? error.message : String(error),
  );
}

/// ボディ受信中の失敗も `ClientException` にする。
///
/// ここで包まないと、実際に読み切るのは最外層の [BaseHttpClient.get]——つまり
/// タイムアウト層の上——になり、fetch 由来の生のエラーがそのまま上位へ抜ける。
function rethrowAsClientException(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(asClientException(error));
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
