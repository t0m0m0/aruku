import { TimeoutException } from '@aruku/engine/services/http-client';
import { seconds, type Duration } from '@aruku/engine/time';

import { BaseHttpClient, type HttpHeaders, type StreamedResponse } from './http';

export interface TimeoutHttpClientOptions {
  readonly timeout?: Duration;
}

/// 内側のクライアントを薄く包み、全リクエストに一律のタイムアウトを付与する（#156）。
///
/// ルート探索は1回の検索で最大13本の HTTP をファンアウトするため、どれか1本が
/// 圏外・弱電波・サーバ無応答でハングすると、ローディング全体が無期限にフリーズする。
/// ヘッダ受信と、その後のボディ受信の chunk 間アイドルの双方に [timeout] を掛ける。
///
/// タイムアウトは [TransitApiClient] が `RouteException('TIMEOUT')` へ変換し、既存の
/// 縮退（失敗レッグは直線推定・候補スキップ）にそのまま乗る。
///
/// [AppCheckHttpClient] と独立した層にするのは、App Check を通さない Transit API
/// 直叩き（ファンアウトの大半）にも一律で掛けるため。App Check を挟む経路では
/// 最外側に置き、トークン取得のハングも [timeout] の内側に収める。
///
/// 超過しても内側は**止めない**。Dart の `Future.timeout` と同じで、実際の中断は
/// `close()` が担う（#259。エンジン側も `withDeadline` で同じ意味論を敷いている）。
export class TimeoutHttpClient extends BaseHttpClient {
  constructor(
    private readonly inner: BaseHttpClient,
    options: TimeoutHttpClientOptions = {},
  ) {
    super();
    this.timeout = options.timeout ?? seconds(15);
  }

  /// 1リクエストあたりの応答待ち上限。超過で [TimeoutException] を送出する。
  readonly timeout: Duration;

  async send(url: URL, headers: HttpHeaders): Promise<StreamedResponse> {
    const response = await withTimeout(
      this.inner.send(url, headers),
      this.timeout,
      `header timeout after ${this.timeout}ms: ${url.href}`,
    );
    return {
      statusCode: response.statusCode,
      body:
        response.body === null
          ? null
          : withIdleTimeout(response.body, this.timeout, url),
    };
  }

  close(): void {
    this.inner.close();
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  limit: Duration,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutException(message)), limit);
  });
  // 先に決着した方で確定し、残ったタイマーは必ず落とす。放置すると内側が遅れて
  // 応答したケースでプロセスが空のタイマーを抱えたままになる。
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/// chunk 間アイドルに上限を掛けたストリームを返す。
///
/// 「全体で何秒」ではなく chunk ごとに測り直すのは移植元に合わせている——ボディが
/// 大きいだけの正常な応答を、細切れでも届いている限り殺さないため。
function withIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  limit: Duration,
  url: URL,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await withTimeout(
          reader.read(),
          limit,
          `body idle timeout after ${limit}ms: ${url.href}`,
        );
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
