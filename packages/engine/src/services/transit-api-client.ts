// 移植元: lib/core/services/transit_api_client.dart

import { dartDouble } from '../dart-number';
import type { JsonMap } from '../json';
import type { GeoPoint } from '../models/geo-point';
import type { CancellationToken } from './cancellation';
import { TimeoutException, type HttpClient, type HttpResponse } from './http-client';
import { RouteException } from './route-service';
import { SearchDeadline } from './search-deadline';
import { durationZero, type Duration } from '../time';

/// `/guidance/plan` の既定の除外モード。バス優勢な区間では `numItineraries` の枠が
/// バス経路で埋まり電車候補が消えるため、主照会は電車のみを要求する（#247）。
const avoidModesTrainOnly = ['bus', 'ferry', 'air'];

/// バスを許容する照会（last-resort 再照会・#250）の除外モード。`ferry`/`air` は
/// [SegmentType] で表現できずパーサが option ごと落とすため、除外したままにする。
const avoidModesAllowBus = ['ferry', 'air'];

/// `/guidance/plan` で取得する候補数。
const numItineraries = 5;

export interface TransitApiClientInit {
  transitClient?: HttpClient;
  proxyClient?: HttpClient;

  /// 未指定時の既定（Dart 版の `AppConfig`）は移していない。設定の出どころは
  /// フロントの配線で、Phase 3（#386）で決める。
  transitBaseUrl?: string;
  proxyBaseUrl?: string;

  /// 検索1回分のキャンセル境界（#259）。null なら中断不能（既定）。
  cancellation?: CancellationToken | null;

  /// 検索1回分の締切（#300）。既定（[SearchDeadline.none]）は無期限。
  deadline?: SearchDeadline;
}

/// Transit API（`/guidance/plan` 直叩き）と Google Routes プロキシへの HTTP 通信を担う
/// クライアント（#169）。[TransitRouteService] から通信の関心事を切り出し、選定ロジックを
/// トランスポートから独立させる。
///
/// 経路取得は Transit API を直叩き（認証不要・CORS）、アクセス徒歩の実測は Google Routes
/// プロキシ（App Check）を介す。1本あたりのタイムアウト（#156）は注入されたクライアント
/// 側で適用され、無応答は `RouteException('TIMEOUT')` へ変換する。
///
/// [cancellation] を渡すと検索単位で中断できる（#259）。クライアントは検索1回分の
/// 寿命で所有され、[close] で in-flight のソケットごと落とす。
export class TransitApiClient {
  constructor(init: TransitApiClientInit = {}) {
    this.transit = init.transitClient ?? null;
    this.proxy = init.proxyClient ?? null;
    this.transitBase = stripTrailingSlashes(init.transitBaseUrl ?? '');
    this.proxyBase = stripTrailingSlashes(init.proxyBaseUrl ?? '');
    this.cancellation = init.cancellation ?? null;
    this.deadline = init.deadline ?? SearchDeadline.none();
  }

  private readonly transit: HttpClient | null;
  private readonly proxy: HttpClient | null;
  private readonly transitBase: string;
  private readonly proxyBase: string;
  readonly cancellation: CancellationToken | null;
  readonly deadline: SearchDeadline;

  // 上流 HTTP 往復本数の実測（#309）。「実際に GET を発行した回数」を種別ごとに数える。
  // 締切切れ・キャンセルで発行前に落ちた要求は往復していないので数えない（[getOrTimeout]
  // が発行直前にだけ onIssued を呼ぶ）。成功・失敗は問わない——本数は叩いた回数であって
  // 成功回数ではない（マトリクスの null 縮退でも往復はしている）。
  private guidanceCallCount = 0;
  private walkCallCount = 0;
  private matrixCallCount = 0;

  // 1検索内で「同一 guidance リクエスト（同じ URI＝同じ from/to/date/time/mode）」を
  // 何本重複発行したかの実測（enrich 削減の判断材料）。クライアントは検索1回ごとに
  // 作り捨て（#259）なので、この Set の寿命＝1検索。値は「guidance キャッシュを噛ませたら
  // 消える本数の上限」を意味する。振る舞いは変えない——キャッシュはまだ入れない。
  private guidanceDupCallCount = 0;
  private readonly guidanceKeys = new Set<string>();

  /// `/guidance/plan` の実 HTTP 往復本数（初回＋引き直し）。
  get guidanceCalls(): number {
    return this.guidanceCallCount;
  }

  /// 上記のうち、同一 URI の重複発行だった本数（guidance キャッシュで消える上限）。
  get guidanceDupCalls(): number {
    return this.guidanceDupCallCount;
  }

  /// Google 徒歩ルート（enrich）の実 HTTP 往復本数。
  get walkCalls(): number {
    return this.walkCallCount;
  }

  /// Google 徒歩マトリクスの実 HTTP 往復本数。
  get matrixCalls(): number {
    return this.matrixCallCount;
  }

  /// 正規化済みの Transit API ベース URL（テスト・観測用）。
  get transitBaseUrl(): string {
    return this.transitBase;
  }

  /// Transit API のベース URL が設定済みか。未設定なら呼び出し側は `NO_TRANSIT_API`
  /// を投げる。設定知識を通信層に閉じ込め、ドメイン層が URL 文字列を覗かないための述語。
  get hasTransitApi(): boolean {
    return this.transitBase.length > 0;
  }

  // ---- Transit API（直叩き） ----

  /// [start]→[goal] を [at] 発で `/guidance/plan` に問い合わせ、生 JSON を返す。
  /// 非200は `RouteException('HTTP <code>')`、無応答は `RouteException('TIMEOUT')`。
  ///
  /// [options.allowBus] を立てるとバスを含む経路も要求する（#250 の last-resort 再照会）。
  /// 既定（false）はバスを除外し電車のみを要求する（#247）。
  async fetchGuidanceAt(
    start: GeoPoint,
    goal: GeoPoint,
    at: Date,
    options: { allowBus?: boolean } = {},
  ): Promise<JsonMap> {
    return this.fetchGuidance(start, goal, {
      date: formatDate(at),
      time: formatTime(at),
      type: 'departure',
      allowBus: options.allowBus ?? false,
    });
  }

  /// [start]→[goal] を「[departureAt] から [budgetMin] 分後」到着で `/guidance/plan` に
  /// 問い合わせ、生 JSON を返す（到着アンカー第2波・#376）。`type` は `arrival`、`time` は
  /// [departureAt] のサービス日基準（[formatServiceTime]）に置き換わる点以外は
  /// [fetchGuidanceAt] と同じ組み立て。[options.allowBus] の意味も同じ。
  async fetchGuidanceArrivalAt(
    start: GeoPoint,
    goal: GeoPoint,
    departureAt: Date,
    budgetMin: number,
    options: { allowBus?: boolean } = {},
  ): Promise<JsonMap> {
    return this.fetchGuidance(start, goal, {
      date: formatDate(departureAt),
      time: formatServiceTime(departureAt, budgetMin),
      type: 'arrival',
      allowBus: options.allowBus ?? false,
    });
  }

  private async fetchGuidance(
    start: GeoPoint,
    goal: GeoPoint,
    anchor: { date: string; time: string; type: string; allowBus: boolean },
  ): Promise<JsonMap> {
    const uri = buildUri(this.transitBase, '/api/v1/guidance/plan', {
      from: `geo:${dartDouble(start.lat)},${dartDouble(start.lng)}`,
      to: `geo:${dartDouble(goal.lat)},${dartDouble(goal.lng)}`,
      date: anchor.date,
      time: anchor.time,
      type: anchor.type,
      numItineraries: `${numItineraries}`,
      avoidModes: (anchor.allowBus
        ? avoidModesAllowBus
        : avoidModesTrainOnly
      ).join(','),
    });
    // 重複判定は実発行時（onIssued）に行い guidanceCalls と数え方を揃える。同一 URI が
    // 二度目以降なら「キャッシュがあればヒットしていた」1本として dup に計上する。
    const key = uri.href;
    const res = await this.getOrTimeout(this.transit, uri, {
      onIssued: () => {
        this.guidanceCallCount++;
        if (this.guidanceKeys.has(key)) this.guidanceDupCallCount++;
        this.guidanceKeys.add(key);
      },
    });
    if (res.statusCode !== 200) {
      throw new RouteException(`HTTP ${res.statusCode}`);
    }
    return decodeJsonMap(res);
  }

  // ---- Google Routes（プロキシ） ----

  /// [origins]×[dests] の徒歩マトリクスを Google プロキシで一括実測し、生の要素配列を返す。
  /// 取得失敗（非200・タイムアウト・非配列）は null（呼び出し側は直線推定へフォールバック）。
  async fetchWalkMatrix(
    origins: GeoPoint[],
    dests: GeoPoint[],
  ): Promise<unknown[] | null> {
    const join = (ps: GeoPoint[]): string =>
      ps.map((p) => `${dartDouble(p.lat)},${dartDouble(p.lng)}`).join(';');
    try {
      return await this.fetchProxyArray(
        'googleWalkMatrixProxy',
        { origins: join(origins), destinations: join(dests) },
        () => this.matrixCallCount++,
      );
    } catch (error) {
      // キャンセル（SearchCanceledException）は握り潰さない。ここで null へ化けると
      // 呼び出し側が直線推定で探索を続行してしまう（#259）。
      if (error instanceof RouteException) return null;
      throw error;
    }
  }

  /// [origin]→[dest] の徒歩を Google Routes(WALK, プロキシ経由)で取得した生ボディを返す。
  /// 非200・無応答は `RouteException`（呼び出し側が routes をパース・失敗を吸収する）。
  fetchWalkRoute(origin: GeoPoint, dest: GeoPoint): Promise<JsonMap> {
    return this.fetchProxy(
      'googleWalkProxy',
      {
        start: `${dartDouble(origin.lat)},${dartDouble(origin.lng)}`,
        goal: `${dartDouble(dest.lat)},${dartDouble(dest.lng)}`,
      },
      () => this.walkCallCount++,
    );
  }

  private async fetchProxy(
    path: string,
    params: Record<string, string>,
    onIssued: () => void,
  ): Promise<JsonMap> {
    const res = await this.getOrTimeout(
      this.proxy,
      buildUri(this.proxyBase, `/${path}`, params),
      { deadlineApplies: false, onIssued },
    );
    if (res.statusCode !== 200) {
      throw new RouteException(`HTTP ${res.statusCode}`);
    }
    return decodeJsonMap(res);
  }

  private async fetchProxyArray(
    path: string,
    params: Record<string, string>,
    onIssued: () => void,
  ): Promise<unknown[]> {
    const res = await this.getOrTimeout(
      this.proxy,
      buildUri(this.proxyBase, `/${path}`, params),
      { deadlineApplies: false, onIssued },
    );
    if (res.statusCode !== 200) {
      throw new RouteException(`HTTP ${res.statusCode}`);
    }
    const decoded = decodeJson(res);
    if (!Array.isArray(decoded)) {
      throw new RouteException('MATRIX_NOT_ARRAY');
    }
    return decoded;
  }

  /// [client] で [uri] を GET し、タイムアウト（#156）を `RouteException('TIMEOUT')` へ
  /// 変換する。これで無応答は既存の UI エラー処理と縮退（失敗レッグは `RouteException`
  /// を捕らえて直線推定・候補スキップ）にそのまま乗る。
  ///
  /// キャンセル判定を全 fetch の共通経路であるここへ置くのは、[fetchWalkMatrix] の
  /// ような縮退の口（`RouteException` → null）の内側で投げても、
  /// [SearchCanceledException] が `RouteException` でない以上そこで握り潰されずに
  /// 抜けるため（#259）。
  ///
  /// [options.deadlineApplies] のとき [deadline] の残予算でも打ち切る（#300）。1本の上限
  /// （35s）だけでは検索全体の最悪待ち時間が「上限 × 直列ラウンド数」に膨らむため、
  /// 残予算でクランプして天井を締切へ落とす。期限切れなら HTTP を発行しない——残予算 0 で
  /// 投げた照会は必ず打ち切られる＝無料・無認証の上流を無駄に叩くだけなので、送る前に落とす。
  ///
  /// **徒歩プロキシには締切を適用しない（`deadlineApplies: false`）。** 締切で切って
  /// よいのは「切っても嘘をつかない」呼び出しだけ、という非対称性がある：
  /// - Transit の引き直しは **fail-closed**。失敗すると候補が `unverified` として除外され
  ///   確証ある候補へ縮退する（§4 #137 approach A）。締切で切っても提示内容は嘘にならない。
  /// - 徒歩の実測は **fail-open**。[TransitRouteService] の enrich は取得失敗時に元の
  ///   見積り（guidance / 直線）を**そのまま残す**。直線は実街路に対し大きく楽観に倒れる
  ///   （実機で -36分・25%）ため、締切で切ると「23分」と名乗る実際46分の全徒歩を確定させ、
  ///   予算超過・乗り遅れの経路を平然と提示する（#254 の不変条件を破る）。
  ///
  /// measure-first の実測は探索の**改善**ではなく確定経路の**検証**であり、締切より優先する。
  /// 探索側（乗車駅探索・代替検証）は [TransitRouteService] が締切でラウンドごと止めるので、
  /// 期限切れ後に走る徒歩実測は確定候補の検証だけ＝本数は候補の区間数で頭打ちになる。
  private async getOrTimeout(
    client: HttpClient | null,
    uri: URL,
    options: { deadlineApplies?: boolean; onIssued?: () => void },
  ): Promise<HttpResponse> {
    this.cancellation?.throwIfCanceled();
    const remaining = (options.deadlineApplies ?? true)
      ? this.deadline.remaining
      : null;
    if (remaining === durationZero) throw new RouteException('TIMEOUT');
    // Dart 版は既定で `http.Client()` を組み立てるが、Phase 1 は既定を置かなかった
    // （設定・トランスポートの出どころは Phase 3・#386 の配線）。RouteException に
    // しないのは、これが経路の結末ではなく**配線漏れ**だから——RouteException は
    // 縮退パス（候補ドロップ・直線推定）に握り潰され、注入し忘れが「徒歩が長い経路」
    // として静かに出てしまう。
    if (client === null) {
      throw new Error('TransitApiClient: no HTTP client was injected');
    }
    try {
      // 往復本数の計上（#309）は「発行が確定した瞬間」にだけ行う。キャンセル・締切切れで
      // 上の 2 ガードに掛かった要求は往復していないので数えない。
      options.onIssued?.();
      const request = client.get(uri);
      return await (remaining === null
        ? request
        : withDeadline(request, remaining));
    } catch (error) {
      if (error instanceof TimeoutException) {
        throw new RouteException('TIMEOUT');
      }
      // throwIfCanceled は発行**前**ガード。発行後に離脱すると scoped client が閉じられ、
      // in-flight は SearchCanceledException ではなく素の client エラー（ClientException 等）で
      // 倒れる。ここで昇格させないと、上位の縮退 catch（#316 の候補ドロップ・レッグ縮退）が
      // キャンセルを握り潰し、離脱後も探索が続いて経路を返してしまう。
      this.cancellation?.throwIfCanceled();
      throw error;
    }
  }

  /// 保持するクライアントを閉じ、in-flight のリクエストを中断する（#259）。
  close(): void {
    this.transit?.close();
    this.proxy?.close();
  }
}

/// Dart の `Future.timeout(d)` に対応する。[promise] を待ちつつ [limit] で
/// [TimeoutException] にする。元の処理は**止まらない**（Dart の `timeout` も同じで、
/// 実際の中断は `close()` が担う）。
function withDeadline<T>(promise: Promise<T>, limit: Duration): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutException(`deadline exceeded after ${limit}ms`)),
      limit,
    );
  });
  // タイマーは必ず落とす。残すとテストランナーがイベントループを掴んだまま終われない。
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildUri(
  base: string,
  path: string,
  params: Record<string, string>,
): URL {
  const uri = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    uri.searchParams.set(key, value);
  }
  return uri;
}

function decodeJson(res: HttpResponse): unknown {
  return JSON.parse(new TextDecoder().decode(res.bodyBytes));
}

/// Dart の `jsonDecode(...) as Map<String, dynamic>` に対応する。オブジェクト以外は
/// 投げる——上流のスキーマ変更を「空の経路」へ化けさせない（transit-plan-parser の
/// キャスト方針と同じ）。
function decodeJsonMap(res: HttpResponse): JsonMap {
  const decoded = decodeJson(res);
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new TypeError('expected a JSON object');
  }
  return decoded as JsonMap;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatDate(dt: Date): string {
  return `${pad(dt.getFullYear(), 4)}${pad(dt.getMonth() + 1, 2)}${pad(dt.getDate(), 2)}`;
}

function formatTime(dt: Date): string {
  return `${pad(dt.getHours(), 2)}:${pad(dt.getMinutes(), 2)}`;
}

/// [departureAt] のサービス日（0時起点）を基準に、そこから [budgetMin] 分後の時刻を
/// `H:mm` で組み立てる。日またぎで H は 24 以上になり得る（例: 25:00）。
///
/// [departureAt] 自身の暦日+HH:mm ではなく到着側の暦日+HH:mm を基準にしないのは、
/// 0時前発車の便をサービス日負秒にせず表現するため（実 API 直測で確認済み・#376）。
///
/// 締切を表す中間の `Date`（`departureAt` にミリ秒を足したもの等）は経由しない。
/// [budgetMin] は呼び出し元で既に TimeValue 由来の名目分として求まっており、それを
/// 経過時間として足すと DST のある端末タイムゾーンでは spring-forward を跨ぐ計算で
/// 壁時計が1時間ずれる（#121 と同じクラス。端末 TZ は JST とは限らない）。壁時計の
/// 年月日時分から `Date` を作り直す代替も、その時刻が DST ギャップに落ちれば同じだけ
/// ずれるため避け、暦フィールドの整数演算だけで完結させる。
function formatServiceTime(departureAt: Date, budgetMin: number): string {
  const total =
    departureAt.getHours() * 60 + departureAt.getMinutes() + budgetMin;
  return `${pad(Math.trunc(total / 60), 2)}:${pad(total % 60, 2)}`;
}
