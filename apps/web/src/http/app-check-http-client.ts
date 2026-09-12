import { ClientException } from '@aruku/engine/services/http-client';

import { BaseHttpClient, type HttpHeaders, type StreamedResponse } from './http';

/// App Check トークンを取得する関数。テストでは Firebase に触れない fake を注入して
/// ヘッダ付与を検証する。
export type AppCheckTokenProvider = () => Promise<string | null>;

export interface AppCheckHttpClientOptions {
  readonly tokenProvider: AppCheckTokenProvider;
  readonly limitedUseTokenProvider: AppCheckTokenProvider;
}

const headerName = 'X-Firebase-AppCheck';

/// サーバが consume:true で検証する関数名。`shouldConsumeAppCheckToken()` の既定
/// （`functions/src/index.ts` の DEFAULT_APP_CHECK_CONSUME_ENDPOINTS）と厳密に
/// 一致させること。
const replayProtectedFunctions = new Set(['placesProxy', 'googleWalkMatrixProxy']);

/// 内側のクライアントを包み、各リクエストに Firebase App Check トークンを
/// X-Firebase-AppCheck ヘッダとして付与する。Cloud Functions プロキシ側は
/// このトークンを検証し、未認証アクセス（API 課金の濫用）を遮断する。
///
/// プロバイダを省略可能にしていないのは、Firebase JS SDK の `getToken` が
/// `initializeAppCheck` の返すインスタンスを要るため。Dart の
/// `FirebaseAppCheck.instance` に相当する静的な入口が無く、既定値を持てない。
///
/// リプレイ保護（#155・#366）: [requiresLimitedUseToken] が真のエンドポイントには
/// 使い捨てトークンを付ける。サーバは verifyToken(token, {consume:true}) で消費済みを
/// 記録し、2 回目以降をリプレイとして 401 で弾く。それ以外はキャッシュ可能な標準トークン。
export class AppCheckHttpClient extends BaseHttpClient {
  constructor(
    private readonly inner: BaseHttpClient,
    private readonly options: AppCheckHttpClientOptions,
  ) {
    super();
  }

  private readonly aborter = new AbortController();

  /// このリクエストにリプレイ保護（使い捨て limited-use トークン）を要求するか。
  ///
  /// 重要（#155・#366）: この判定はサーバ側の consume 対象と**厳密に**一致させること。
  ///   ずれは両方向とも実害がある:
  ///   - 対象を取りこぼし標準（キャッシュ再利用）トークンを送ると、サーバは 2 回目
  ///     以降を消費済みとして 401 で拒否する → そのエンドポイントが壊れる。
  ///   - 逆に非対象へ使い捨てトークンを送ると、要求ごとに新規アテステーションが走り
  ///     クォータを焼く。枯渇すると取得が throw し、下の catch がヘッダを落とし、
  ///     結局そのプロキシは全要求 401 になる。
  ///   「取りこぼしにくい向きへ広めに拾う」は採らない。クォータが拘束条件になった
  ///   #366 以降、広め方向も同じだけ危険。
  ///
  /// 関数名は URL パスの末尾セグメント（gen2 直 URL では '/placesProxy'）。パス末尾を
  /// 変えるリライト（例 '/api/places'）を入れる場合はここも更新すること。
  static requiresLimitedUseToken(url: URL): boolean {
    const segments = url.pathname.split('/').filter((s) => s !== '');
    const last = segments.at(-1);
    return last !== undefined && replayProtectedFunctions.has(last);
  }

  async send(url: URL, headers: HttpHeaders): Promise<StreamedResponse> {
    const needsLimitedUse = AppCheckHttpClient.requiresLimitedUseToken(url);
    let token = await this.tokenOrClosed(
      needsLimitedUse
        ? this.options.limitedUseTokenProvider
        : this.options.tokenProvider,
      url,
    );

    // 使い捨ての取得に失敗したら標準トークンへ縮退する。
    //
    // なぜ縮退させるか: アテステーション・クォータが枯渇すると使い捨ての取得は
    // throw する。ここで諦めるとヘッダ無し＝サーバは「トークン欠落」で 401 を返し、
    // その経路は consume 設定を一切見ない。つまりサーバ側の緊急停止
    // （APP_CHECK_CONSUME_ENDPOINTS=""）だけでは復旧できない。標準トークンへ落とせば、
    // 停止と組み合わせて完全に復旧できる。
    //
    // 停止していない場合でも劣化に留まる: 1 回目は通り、同じトークンの 2 回目以降が
    // リプレイとして 401 になる。全要求 401 よりは良い。
    if (token === null && needsLimitedUse) {
      token = await this.tokenOrClosed(this.options.tokenProvider, url);
    }

    return this.inner.send(
      url,
      token === null ? headers : { ...headers, [headerName]: token },
    );
  }

  close(): void {
    this.aborter.abort();
    this.inner.close();
  }

  /// トークンを取りに行く。取得中に [close] されたら待たずに倒れる。
  ///
  /// 待ち続けると、検索の離脱後もタイムアウト（既定15秒）まで送信前の要求が残る。
  /// 内側の fetch を閉じても、まだ fetch に達していないこの待ちは止まらない。
  /// アテステーションも走り続けるのでクォータを無駄に焼く（#259・PR #391 レビュー）。
  private async tokenOrClosed(
    provider: AppCheckTokenProvider,
    url: URL,
  ): Promise<string | null> {
    if (this.aborter.signal.aborted) {
      throw new ClientException(`Client is already closed: ${url.href}`);
    }

    let onAbort: (() => void) | null = null;
    const closed = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          new ClientException(
            `Client was closed while acquiring an App Check token: ${url.href}`,
          ),
        );
      this.aborter.signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      return await Promise.race([tokenFrom(provider), closed]);
    } finally {
      // 決着後にリスナを残さない。1リクエストごとに積むので、外さないと
      // 検索1回（最大13本）ぶんが close まで居座る。
      if (onAbort !== null) {
        this.aborter.signal.removeEventListener('abort', onAbort);
      }
    }
  }
}

/// プロバイダからトークンを取り出す。取得できなければ null。
///
/// 取得はプラットフォーム未登録（例: App Check 未設定）やアテステーション・クォータ
/// 枯渇で例外を投げうる。ここで握りつぶしてもプロキシ側が本番ではトークンを必須化
/// しており（未トークンは 401）、安全側に倒れる。例外を伝播させるとリクエスト自体が
/// 落ち、エミュレータ等の検証免除環境まで巻き添えになる。
/// 空文字列は未トークンと同義（プロキシ側で検証不能）のため null に畳む。
async function tokenFrom(provider: AppCheckTokenProvider): Promise<string | null> {
  try {
    const token = await provider();
    return token === null || token === '' ? null : token;
  } catch {
    return null;
  }
}
