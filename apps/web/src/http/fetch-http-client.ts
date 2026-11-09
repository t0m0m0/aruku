import { ClientException } from '@aruku/engine/services/http-client';

import {
  BaseHttpClient,
  type HttpHeaders,
  type RequestOptions,
  type StreamedResponse,
} from './http';

/// テストが実ネットワークに触れずに済むよう注入可能にする。
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchHttpClientOptions {
  readonly fetch?: Fetch;
}

/// `fetch` をエンジンの `HttpClient` 契約へ嵌める最内層。Dart の `http.Client()` の位置。
///
/// [close] はクライアント1つぶんの `AbortController` を倒す。検索1回ぶんの寿命で
/// 所有し、離脱時に in-flight のソケットごと落とす設計（#259）の実体がこれ。
/// 要求の `signal`（#488）はその要求1本だけを落とし、どちらが倒れても fetch は止まる。
export class FetchHttpClient extends BaseHttpClient {
  private readonly fetch: Fetch;
  private readonly aborter = new AbortController();

  constructor(options: FetchHttpClientOptions = {}) {
    super();
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async send(
    url: URL,
    headers: HttpHeaders,
    options: RequestOptions = {},
  ): Promise<StreamedResponse> {
    // 中断済みで発行しないのは Dart の `http.Client` が閉じた後の送信を
    // ClientException で拒むのと同じ。上位から見て「閉じた後は失敗する」が揃う。
    if (this.aborter.signal.aborted) {
      throw new ClientException(`Client is already closed: ${url.href}`);
    }
    if (options.signal?.aborted === true) {
      throw new ClientException(`Request was aborted: ${url.href}`);
    }

    const linked = linkSignals(this.aborter.signal, options.signal);
    let response: Response;
    try {
      response = await this.fetch(url.href, { headers, signal: linked.signal });
    } catch (error) {
      linked.release();
      throw asClientException(error);
    }

    if (response.body === null) {
      linked.release();
      return { statusCode: response.status, body: null };
    }
    return {
      statusCode: response.status,
      body: rethrowAsClientException(response.body, linked.release),
    };
  }

  close(): void {
    this.aborter.abort();
  }
}

/// 通信の失敗を `ClientException` へ寄せる。
///
/// 中断（AbortError）も同じ扱いにする。キャンセルは呼び出し側が表現する層で、
/// トランスポートから見れば「閉じられたので倒れた」でしかない——エンジンはこの区別を
/// `cancellation.throwIfCanceled()` で付け直し（transit-api-client.ts の catch）、
/// 地点検索は検索の世代で捨てる（search-state.ts）。
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
///
/// 読み終えた・倒れた・捨てられた時点で [onSettled] を呼ぶ（signal のつなぎを外す）。
function rethrowAsClientException(
  stream: ReadableStream<Uint8Array>,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          onSettled();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        onSettled();
        controller.error(asClientException(error));
      }
    },
    cancel: (reason) => {
      onSettled();
      return reader.cancel(reason);
    },
  });
}

/// クライアントの中止と要求の中止のどちらでも倒れる signal を作る。
///
/// `AbortSignal.any` を使わないのは、ビルドの対象ブラウザ（Vite 既定の
/// baseline-widely-available）に入っていないため。手でつなぐ代わりに、要求が
/// 決着したら [release] でクライアント側のリスナを外す——地点検索の client は
/// アプリ寿命なので、外さないと要求の数だけリスナが積もる。
function linkSignals(
  client: AbortSignal,
  request: AbortSignal | undefined,
): { signal: AbortSignal; release: () => void } {
  if (request === undefined) return { signal: client, release: () => {} };

  const linked = new AbortController();
  const abort = () => linked.abort();
  client.addEventListener('abort', abort, { once: true });
  request.addEventListener('abort', abort, { once: true });
  return {
    signal: linked.signal,
    release: () => {
      client.removeEventListener('abort', abort);
      request.removeEventListener('abort', abort);
    },
  };
}
