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
///
/// この抽象を満たす実装（`fetch` アダプタ・タイムアウト・App Check）はエンジンに置かない
/// ——どれも「どこから設定を取るか」の配線で、エンジンの仕様ではないため。組み立ては
/// Phase 3（#386）のフロント側で行う（`route-service.ts` の冒頭も同じ理由で Riverpod の
/// provider を移していない）。
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
