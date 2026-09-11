// 移植元: package:http の `Client` / `Response` のうち、エンジンが実際に使う面だけ。

/// Dart の `http.Response` のうちエンジンが読む2つ。
export interface HttpResponse {
  readonly statusCode: number;
  readonly bodyBytes: Uint8Array;
}

/// Dart の `http.Client` のうちエンジンが呼ぶ2つ。
///
/// `fetch` + `AbortController` に置き換えていない。中断は「検索1回分の寿命で所有した
/// クライアントを [close] して in-flight のソケットごと落とす」設計で（#259。
/// lib/core/services/cancellation.dart）、その意味論に依存したテストがある。
/// Phase 1（#384）でここを作り替えると、移植ミスと設計変更が混ざって切り分けられない。
/// `fetch` への適合は実装側（#385）の仕事。
export interface HttpClient {
  get(url: URL): Promise<HttpResponse>;
  close(): void;
}

/// Dart の `http.ClientException` に対応する。閉じられたクライアントを叩いた
/// in-flight が倒れるときの素の通信エラー。
export class ClientException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientException';
  }
}

/// Dart の `TimeoutException`（`dart:async`）に対応する。1本あたりの上限を張る
/// クライアント（`TimeoutHttpClient` 相当）が投げ、[TransitApiClient] が
/// `RouteException('TIMEOUT')` へ変換する。
export class TimeoutException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutException';
  }
}
