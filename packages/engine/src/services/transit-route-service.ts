// 移植元: lib/core/services/transit_route_service.dart

import { dartRound } from '../dart-number';
import type { JsonMap } from '../json';
import { GeoPoint } from '../models/geo-point';
import {
  RouteSegment,
  SegmentType,
  type RoutePlan,
} from '../models/route-plan';
import type { TimeValue } from '../models/time-value';
import { decodePolyline } from '../polyline';
import { startedStopwatch } from '../stopwatch';
import { dateTime, seconds, type Duration } from '../time';
import { SearchCanceledException, type CancellationToken } from './cancellation';
import {
  evenSample,
  forwardCandidates,
  frontierStations,
  haversineKm,
  maxWalkBoardingIndexParallel,
  measureShortlist,
  prewarmFront,
  reachableWithinBudget,
  RouteCandidate,
  selectBestRoute,
  walkFeasiblePrefixCount,
  type FrontierStations,
} from './hybrid-route-selector';
import { TimeoutException, type HttpClient } from './http-client';
import {
  ArrivalWaveOutcome,
  BestEffortLedger,
  BoardSearchStats,
  EnrichLatencyLedger,
  RouteDiagnostics,
  RouteSearchMetrics,
} from './route-diagnostics';
import {
  arrivalMinutes,
  buildRoutePlan,
  effectiveOffset,
  firstMissedTransit,
  hasUnverifiedTransit,
  kcalPerKm,
  trainMetersPerMinute,
  walkMetersPerMinute,
} from './route-plan-builder';
import {
  RouteException,
  RoutePhase,
  type PlanArgs,
  type SearchEngine,
} from './route-service';
import { SearchDeadline } from './search-deadline';
import {
  parseGuidancePlan,
  type TransitOption,
} from './transit-plan-parser';
import { TransitApiClient } from './transit-api-client';

/// 選定・enrich 検証の結果一式。[chosen] は enrich 前の選定候補（guidance 見積りのまま）、
/// [enriched] は Google 実測で確定した採用経路。
interface Selection {
  chosen: RouteCandidate;
  enriched: RouteCandidate;
}

export interface TransitRouteServiceInit {
  transitClient?: HttpClient;
  proxyClient?: HttpClient;
  transitBaseUrl?: string;
  proxyBaseUrl?: string;
  clock?: () => Date;
  cancellation?: CancellationToken | null;
  deadline?: SearchDeadline;

  /// 1検索分の定量指標（#309）の受け取り口。既定 null（本番は診断ログ出力のみ）。
  onMetrics?: (metrics: RouteSearchMetrics) => void;

  /// 到着アンカー第2波（#376）を departure 波の確定後に待つ猶予。テストが実時間に
  /// 依存せず猶予切れを再現できるよう注入可能にしてある。
  arrivalWaveGrace?: Duration | null;
}

/// 到着アンカー第2波の猶予の既定値。
///
/// **無期限に待たない理由:** 並列に投げた guidance の裾は実測 33〜43 秒まで伸びる。
/// 改善でしかない波を待ち切ると、その裾が毎検索の体感へそのまま乗る。
/// **0 にしない理由:** 両波は同時に発行済みで、この時点の第2波は既に departure 波
/// ぶんの時間を走っている。0 にすると、あと一息で返る応答まで捨てることになる。
export const defaultArrivalWaveGrace: Duration = seconds(5);

/// 見積り予算内候補を1回の並列パスで実測する短リストの本数上限（#315）。
/// 上限はレート制限（#161: 1検索最大13ファンアウト）に合わせる。
export const maxMeasureShortlist = 13;

/// base ごとのハイブリッド候補をマージするときの総数上限（#292）。
export const maxHybridCandidates = 40;

/// 非崩壊ルートの先行実測を「見積りフロント」から「予算内短リスト全体」へ広げる
/// （Option A・#318）発火しきい値。
const singlePassHybridThreshold = 3;

/// アクセス徒歩を一括実測するマトリクスの片側の駅数上限（要素数課金を抑える）。
const maxMatrixSideStations = 10;

/// 乗車駅探索フォールバックの起動しきい値（崩壊判定・§7）。
const collapseWalkMarginMin = 10;
const collapseSlackRatio = 0.4;

/// 崩壊判定の余り条件（症状2）の絶対値しきい値（分）。相対・絶対のいずれかを満たせば
/// 「予算が大きく余っている」とみなす（#137）。
const collapseSlackMinutes = 20;

/// 乗車駅探索のk分割並列探索の並列度（#163・#317 で 3→5）。上げるほどラウンド数が減るが、
/// 上流の**未知の**レート制限を踏み抜くと probe ぶんの候補を失い、徒歩が静かに短くなる。
const boardSearchFanout = 5;

/// フロンティア t1 一括実測マトリクスの1コールあたり目的地数の上限（#317）。サーバ側
/// `MATRIX_MAX_ELEMENTS`（functions/src/index.ts・25）を超えると 400 で全滅するため分割する。
const maxScanMatrixDests = 25;

/// 乗車駅探索のコリドー候補点の上限（§2.3）。
const maxCorridorStops = 60;

/// ハイブリッドの土台に据える路線ファミリ base の本数上限（#292）。
const maxHybridBases = 3;

/// 路線名を欠くコリドーのフィンガープリントで拾うサンプル点数。
const corridorFingerprintSamples = 8;

/// Transit API（`/guidance/plan`）から、予算内で徒歩を最大化するルートを生成する
/// `RouteService`（#137）。
///
/// 経路取得は Transit API を直叩き（認証不要・CORS）、アクセス徒歩の実測だけは
/// Google Routes プロキシ（App Check）を介す。選定（measure-first・乗車駅探索・
/// best-effort 縮退）と純粋関数（[selectBestRoute]/[maxWalkBoardingIndexParallel]/
/// [frontierStations]/[arrivalMinutes]/[buildRoutePlan]）はデータ源非依存。
///
/// データ源の制約が設計を決めている（docs/spec/route-optimization.md §2.2）：
/// - 途中停車駅を leg が持たないため、transit polyline（コリドー座標）で代替する。
/// - 運賃は上流が返さないため常に null（§2.2-3）。
/// - 乗り遅れ再照会（#115）は乗車駅探索へ一本化した。
export class TransitRouteService implements SearchEngine {
  constructor(init: TransitRouteServiceInit = {}) {
    this.arrivalWaveGrace = init.arrivalWaveGrace ?? defaultArrivalWaveGrace;
    this.api = new TransitApiClient({
      transitClient: init.transitClient,
      proxyClient: init.proxyClient,
      transitBaseUrl: init.transitBaseUrl,
      proxyBaseUrl: init.proxyBaseUrl,
      cancellation: init.cancellation,
      deadline: init.deadline ?? SearchDeadline.none(),
    });
    this.deadline = init.deadline ?? SearchDeadline.none();
    this.clock = init.clock ?? ((): Date => new Date());
    this.onMetrics = init.onMetrics ?? null;
  }

  /// Transit API / Google プロキシへの HTTP 通信（#169）。
  private readonly api: TransitApiClient;
  private readonly clock: () => Date;

  /// 検索1回分の締切（#300）。超過したら**引き直しの新ラウンドを起こさない**。
  /// ゲートするのは改善側だけで、必須の初期照会は締切で止めない。
  private readonly deadline: SearchDeadline;
  private readonly arrivalWaveGrace: Duration;
  private readonly onMetrics: ((metrics: RouteSearchMetrics) => void) | null;

  /// 選定の診断ログ整形（#169）。`verbose` は既定で kDebugMode。
  private readonly diag = new RouteDiagnostics();

  async plan(args: PlanArgs): Promise<RoutePlan> {
    const { departure, arrival, destination, destinationLatLng } = args;
    const origin = args.origin ?? null;
    const onProgress = args.onProgress;
    if (!this.api.hasTransitApi) throw new RouteException('NO_TRANSIT_API');
    if (origin === null) throw new RouteException('NO_ORIGIN');
    if (destinationLatLng === null || destinationLatLng === undefined) {
      throw new RouteException('NO_DESTINATION');
    }
    const budgetMin = budgetMinutesOf(departure, arrival);

    // 定量指標（#309）は plan 入口〜確定までを1オブジェクトに集約する。ZERO_RESULTS 等で
    // 途中離脱した検索は集計対象にしない——器を作るのは初回 guidance が成功した後にする。
    const metrics = new RouteSearchMetrics();
    const totalSw = startedStopwatch();

    onProgress?.(RoutePhase.routing);

    const departureAt = this.departureDateTime(departure);
    // 到着アンカー第2波（#376）。締切（出発+予算）から後ろ向きに探した便列を第2の母集合と
    // して合流する。**departure 波を await する前に起こす**——後ろに置くと並列でなくなり、
    // 上流1本ぶんの段（実測 ~20s）が丸ごと体感へ乗る。
    const arrivalWave = this.api.fetchGuidanceArrivalAt(
      origin,
      destinationLatLng,
      departureAt,
      budgetMin,
    );
    // 捨てる経路（departure 波が先に落ちる）で未処理例外にしないための番人。Promise は
    // 複数のリスナを持てるので、後から await する経路の例外伝播は妨げない——キャンセル
    // （[SearchCanceledException]）を握り潰さないために必要な性質（`prefetchBus` と同型・#316）。
    ignore(arrivalWave);

    const guidanceSw = startedStopwatch();
    const body = await this.api.fetchGuidanceAt(
      origin,
      destinationLatLng,
      departureAt,
    );
    metrics.guidanceMs = guidanceSw.elapsedMilliseconds;
    const options = parseGuidancePlan(body);
    if (options.length === 0) throw new RouteException('ZERO_RESULTS');

    onProgress?.(RoutePhase.walkability);

    // 第2波を待つのは departure 波が返ってから [arrivalWaveGrace] までに限る（猶予切れは
    // 失敗と同じ fail-soft）。元の Promise は `ignore` 済みなので、猶予後に遅れて届く
    // 失敗が未処理例外にはならない。キャンセルは猶予内なら素通しで上へ抜ける。
    const wave = await this.arrivalWaveOptions(
      withGrace(arrivalWave, this.arrivalWaveGrace),
      options,
    );
    metrics.arrivalWaveOutcome = wave.outcome;
    metrics.arrivalWaveOptions = wave.fresh.length;

    const plan = await this.selectMeasured(
      [...options, ...wave.fresh],
      budgetMin,
      departure,
      {
        origin,
        goal: destinationLatLng,
        onProgress,
        fromName: args.originName ?? null,
        toName: destination,
        metrics,
        // option には出自欄が無いのでインスタンス同一性で追う（合流も `basesForHybrid` も
        // インスタンスをそのまま持ち回るので保たれる）。
        arrivalWaveOptions: new Set(wave.fresh),
      },
    );

    // 上流本数は API クライアントの実測カウンタから、全体時間は Stopwatch から確定させ、
    // 1検索分の指標を1行に出す。
    metrics.totalMs = totalSw.elapsedMilliseconds;
    metrics.guidanceCalls = this.api.guidanceCalls;
    metrics.guidanceDupCalls = this.api.guidanceDupCalls;
    metrics.walkCalls = this.api.walkCalls;
    metrics.matrixCalls = this.api.matrixCalls;
    this.diag.logMetrics(metrics);
    this.onMetrics?.(metrics);

    return plan;
  }

  close(): void {
    this.api.close();
  }

  /// 到着アンカー第2波（#376）の応答を option 列へ解析し、[departureOptions] と構造が
  /// 重複しないもの（`fresh`）と、応答自体が使えたか（`outcome`）を返す。
  ///
  /// 失敗（HTTP・TIMEOUT・パース不能・猶予切れ）を握って空リストへ落とすのは、この波が
  /// 「改善」であって必須ではないから（必須は departure 波1本・§2.4）。ただし
  /// [SearchCanceledException] だけは飲まない——飲むと検索から離脱した後も departure 波
  /// だけで完走して経路を返してしまう（#316）。
  private async arrivalWaveOptions(
    wave: Promise<JsonMap>,
    departureOptions: TransitOption[],
  ): Promise<{ outcome: ArrivalWaveOutcome; fresh: TransitOption[] }> {
    try {
      const parsed = parseGuidancePlan(await wave);
      const seen = new Set(departureOptions.map((o) => this.optionKey(o)));
      const fresh: TransitOption[] = [];
      for (const o of parsed) {
        const key = this.optionKey(o);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(o);
      }
      this.diag.log(
        () => `arrival 波: ${parsed.length} options → 純増 ${fresh.length}件を合流`,
      );
      return {
        outcome:
          parsed.length === 0 ? ArrivalWaveOutcome.empty : ArrivalWaveOutcome.ok,
        fresh,
      };
    } catch (error) {
      if (error instanceof SearchCanceledException) throw error;
      if (error instanceof TimeoutException) {
        // 猶予切れは上流エラーと分ける。合流できる素材が無いのは同じでも、こちらは
        // 第2波の中身を一度も見ていない＝仮説の是非を語らない（#376・§3.8）。
        this.diag.log(() => 'arrival 波: 猶予切れ → departure 波のみで続行');
        return { outcome: ArrivalWaveOutcome.timeout, fresh: [] };
      }
      this.diag.log(
        () => `arrival 波: 失敗（${String(error)}）→ departure 波のみで続行`,
      );
      return { outcome: ArrivalWaveOutcome.error, fresh: [] };
    }
  }

  /// measure-first 選定。標準乗換・実測ハイブリッド・全徒歩を同一土俵で比較し、
  /// 採用候補を Google 実測（enrich）で検証して確定する。徒歩最大化が崩壊したときだけ
  /// 乗車駅探索（引き直し）を1本足して選び直す。
  ///
  /// `arrivalWaveOptions` は [options] のうち到着アンカー第2波（#376）由来のインスタンス。
  /// 選定そのものには影響せず、採用状況の計測だけに使う。
  private async selectMeasured(
    options: TransitOption[],
    budgetMin: number,
    departure: TimeValue,
    ctx: {
      origin: GeoPoint;
      goal: GeoPoint;
      metrics: RouteSearchMetrics;
      arrivalWaveOptions: Set<TransitOption>;
      onProgress?: (phase: RoutePhase) => void;
      fromName: string | null;
      toName: string | null;
    },
  ): Promise<RoutePlan> {
    const { origin, goal, metrics, arrivalWaveOptions } = ctx;
    const departureAt = this.departureDateTime(departure);
    this.diag.log(
      () =>
        `=== plan start: budget=${budgetMin}m departureAt=${String(departureAt)} ` +
        `options=${options.length} ===`,
    );
    const walkCache = new WalkLegCache();
    // enrich の臨界パスを「パス本数」と「1候補の直列段数」に分けて計上する（#318）。
    const enrichLedger = new EnrichLatencyLedger();
    // 縮退は測定口を通らないので別台帳。実測では enrichMs の9割がここだった。
    const bestEffortLedger = new BestEffortLedger();
    const measured = new Map<string, number>();
    // 候補の実測（enrich 徒歩＋実発車時刻解決）を identity で畳むキャッシュ（#315）。
    const enrichedCache = new Map<RouteCandidate, RouteCandidate>();

    // ハイブリッド候補（コリドー実測由来）の identity 集合。予算内にこれが多いほど
    // reject 多発＝先行実測を短リスト全体へ広げる（Option A・#318）。
    const hybrids = new Set<RouteCandidate>();

    // 標準乗換候補（guidance の door-to-door をそのまま候補化）。
    const candidates: RouteCandidate[] = options.map(
      (o) => new RouteCandidate({ from: o.from, to: o.to, segments: o.segments }),
    );
    for (const c of candidates) {
      this.diag.log(
        () => `standard: ${this.diag.candLine(c, budgetMin, departureAt)}`,
      );
    }

    // 到着アンカー第2波（#376）由来の候補をインスタンス同一性で覚える（`arrivalWaveWon`）。
    // 候補にも option にも出自欄は無く、足すと選定の純粋関数群まで型が波及するので、
    // 生成箇所で対応を控える側を採る。上の map は options と1対1・同順。
    const fromArrivalWave = new Set<RouteCandidate>();
    for (let i = 0; i < options.length; i++) {
      if (arrivalWaveOptions.has(options[i])) fromArrivalWave.add(candidates[i]);
    }

    // 単一最速ではなく路線ファミリの異なる複数 base を土台にする（#292・限界2）。
    const bases = this.basesForHybrid(options);
    // 崩壊時の board-search は単一 base を土台にする（#137）。先頭は総所要最小＝従来の
    // baseForHybrid と一致するため、崩壊フォールバックの挙動は #292 前と変わらない。
    const base = bases.length === 0 ? null : bases[0];
    metrics.arrivalWaveBaseUsed = bases.some((b) => arrivalWaveOptions.has(b));
    const hybridSw = startedStopwatch();
    if (bases.length > 0) {
      this.diag.log(() => `hybrid bases: ${bases.length}家系`);
      // base ごとの実測（マトリクス IO）は互いに独立なので並列に投げる（#163）。
      // `measured` は共有するが、書き込みは各 await 後に同一値で冪等なので競合しない。
      const built = await Promise.all(
        bases.map((b) =>
          this.buildCorridorHybrids(b, origin, goal, budgetMin, departureAt, measured),
        ),
      );
      for (let i = 0; i < bases.length; i++) {
        if (arrivalWaveOptions.has(bases[i])) {
          for (const c of built[i]) fromArrivalWave.add(c);
        }
      }
      const merged = this.mergeHybrids(
        built,
        (h) => arrivalMinutes(h.segments, departureAt) <= budgetMin,
      );
      candidates.push(...merged);
      for (const h of merged) hybrids.add(h);
      this.diag.log(
        () => `merged hybrids: ${merged.length}件（上限${maxHybridCandidates}）`,
      );
    } else {
      this.diag.log(() => 'no base route (corridor<2); all-walk only');
      await this.measureAccessWalks(origin, goal, [], [], measured);
    }
    metrics.hybridMs = hybridSw.elapsedMilliseconds;

    const allWalk = this.measuredWalk(
      origin,
      goal,
      options[0].from,
      options[0].to,
      measured,
    );
    candidates.push(allWalk);
    this.diag.log(
      () => `allWalk: ${this.diag.candLine(allWalk, budgetMin, departureAt)}`,
    );
    this.diag.log(() => `total candidates: ${candidates.length}`);

    // last-resort のバス再照会は高々1回。**採用**されるのは予算内候補が出ないときだけ（#250）。
    let busOptions: TransitOption[] | null = null;
    let busCandidates: RouteCandidate[] | null = null;
    let busFetch: Promise<TransitOption[]> | null = null;

    // 照会だけ先に始める（投機）。`giveUp` は best-effort の実測結果が出るまで採用の可否を
    // 決められないが、**照会自体はその結果に依存しない**。直列に置くと上流1本ぶんの段が
    // 丸ごと体感へ乗る（実機 12.6s）ので、判断を待たずに発行して段を重ねる。
    //
    // **ここで `busOptions` を埋めてはいけない。** `isCollapse` の比較集合と `busBaseFor` は
    // `busOptions` の非 null を「バスが土俵に乗ったか」の判定に使っている。投機で埋めると、
    // バスが勝っていない検索でも比較集合が膨らんで `bestStandardWalk` が上がり、崩壊が
    // 不成立になって board-search が静かに抑制され得る（＝徒歩最大化の劣化）。
    const prefetchBus = (): void => {
      if (busCandidates !== null || busFetch !== null) return;
      busFetch = this.fetchBusOptions(origin, goal, departureAt);
      ignore(busFetch);
    };

    const lastResortBus = async (): Promise<RouteCandidate[]> => {
      if (busCandidates !== null) return busCandidates;
      prefetchBus();
      // 計上するのは**投機で覆えなかった残りの直列待ち**（発行から完了までの全体ではない）。
      const waitSw = startedStopwatch();
      busOptions = await busFetch!;
      metrics.busLastResortMs = waitSw.elapsedMilliseconds;
      busCandidates = busOptions.map(
        (o) => new RouteCandidate({ from: o.from, to: o.to, segments: o.segments }),
      );
      return busCandidates;
    };

    // 崩壊が見込まれないなら、見積りフロントを1回の並列パスで先行実測して
    // [enrichedCache] を温める（#315）。判定は見積り勝者で行い、実測を待たない。
    const estWinner = selectBestRoute({
      candidates,
      budgetMin,
      origin,
      goal,
      departureAt,
    });
    const estWithin =
      arrivalMinutes(estWinner.segments, departureAt) <= budgetMin;
    const preCollapse =
      base !== null &&
      estWithin &&
      this.isCollapse(estWinner, options, budgetMin, departureAt);

    // 崩壊が見込まれるなら、電車系 board-search を enrich と**並行に**起動する（#341）。
    // 前倒しできる根拠は依存関係にある: [base] は guidance の map セグメントだけから決まり、
    // enrich の出力を一切読まない。
    //
    // **バス系（busBase）は前倒ししない。** あちらは `selected.chosen` から決まる＝enrich の
    // 出力に依存するので、勝者未確定の時点では基準コリドーがまだ存在しない。
    const trainBoardSearch = new BoardSearchStats();
    // 確定候補が board-search の何ラウンド由来かを引くための同一性マップ（両系統で共有）。
    const boardSearchRoundOf = new Map<RouteCandidate, number>();
    let speculationAbandoned = false;
    let trainBoardSearchFuture: Promise<RouteCandidate[]> | null = null;
    if (base !== null && preCollapse) {
      this.diag.log(
        () => 'preCollapse=true → 電車系 board-search を enrich と並行に投機起動',
      );
      metrics.boardSearchSpeculated = true;
      trainBoardSearchFuture = this.buildBoardSearchCandidate(
        base,
        origin,
        goal,
        budgetMin,
        departureAt,
        walkCache,
        trainBoardSearch,
        boardSearchRoundOf,
        () => speculationAbandoned,
      );
      // 捨てる経路（collapse=false）で未処理例外にしないための番人（`prefetchBus` と同型）。
      ignore(trainBoardSearchFuture);
    }

    const enrichSw = startedStopwatch();
    if (estWithin && !preCollapse) {
      // 先行実測の対象は [prewarmFront] が決める：予算内ハイブリッドが多い reject 多発ルートは
      // 短リスト全体を1パスで温めて reject 後の2パス目を畳み（Option A・#318）、そうでなければ
      // 従来どおり見積りフロントだけを温める（Option B・#315）。
      const shortlist = measureShortlist({
        candidates,
        budgetMin,
        departureAt,
        origin,
        goal,
      });
      // 締切切れなら Option A の広い先行実測を許さない（#318 レビュー対応）。
      const front = prewarmFront({
        shortlist,
        chosen: estWinner,
        hybrids,
        singlePassHybridThreshold,
        maxMeasureShortlist,
        allowSinglePass: !this.deadline.isExpired,
      });
      const prewarm = front.prewarm;
      metrics.singlePassMeasure = front.singlePass;
      this.diag.log(() =>
        front.singlePass
          ? `非崩壊: 予算内短リスト${prewarm.length}件を1パスで先行実測（#318 Option A: reject多発ルート）`
          : `非崩壊: 見積りフロント${prewarm.length}件を1パスで先行実測（#315 winner 先行実測）`,
      );
      // 例外は候補単位で握る。先行実測はキャッシュ温めの最適化にすぎず、壊れた応答1件で
      // plan() 全体を落としてはならない。ただしキャンセルだけは飲まない（#316）。
      await Promise.all(
        prewarm.map((c) =>
          this.measureOrDrop(c, departureAt, walkCache, enrichedCache, enrichLedger),
        ),
      );
      enrichLedger.endPass();
    }
    let selected = await this.selectAndEnrich(candidates, budgetMin, departureAt, {
      origin,
      goal,
      walkCache,
      enrichedCache,
      enrichLedger,
      bestEffortLedger,
      lastResortBus,
      prefetchBus,
    });
    // 崩壊後の再選定でも enrich は走り、その費用は同じ台帳へ積まれる。ここで時計を
    // 止めっぱなしにすると、台帳が覆う区間より enrichMs が短くなり計上外の残りが負に化ける。
    enrichSw.stop();

    this.diag.log(
      () =>
        'selected(initial): ' +
        `chosen(見積り)=${this.diag.candLine(selected.chosen, budgetMin, departureAt)} | ` +
        `enriched(実測)=${this.diag.candLine(selected.enriched, budgetMin, departureAt)}`,
    );

    // last-resort のバスが勝ったら、そのバス corridor も徒歩最大化の基準に据える（#251）。
    const busBase = this.busBaseFor(selected.chosen, busCandidates, busOptions);

    // 崩壊判定は enrich 前の選定候補で行う。enrich 後の徒歩は Google 実街路で膨らみ、
    // 標準乗換の guidance 見積り徒歩と測定基準がずれるため。
    const collapseOptions =
      busOptions === null ? options : [...options, ...(busOptions as TransitOption[])];
    const collapse =
      (base !== null || busBase !== null) &&
      this.isCollapse(selected.chosen, collapseOptions, budgetMin, departureAt);
    metrics.collapseFired = collapse;
    if (collapse) {
      metrics.boardSearchActivated = true;
      const boardSw = startedStopwatch();
      this.diag.log(() => 'collapse=true → board-search フォールバック起動');
      // 電車系（base）とバス系（busBase）は基準コリドーが独立なので並列に走らせる（#304）。
      // 計上も探索ごとに分ける——1つの metrics を両方から触ると scanCount/best が別々の
      // 探索の値で対を成さなくなり、rounds は並列に走ったものの和になる。
      const busBoardSearch = new BoardSearchStats();
      const systems: Promise<RouteCandidate[]>[] = [];
      if (base !== null) {
        // バスが勝ったときも電車 base の board-search は走らせる（#250 の発火条件は
        // 「予算外**または乗り遅れ**」なので、手前の駅から引き直せば後続便で予算内に
        // 入ることがある）。投機起動済み（#341）ならその Promise をそのまま待つ——
        // ここで起こし直すと同じ探索を二重に走らせて上流本数が倍になる。
        systems.push(
          trainBoardSearchFuture ??
            this.buildBoardSearchCandidate(
              base,
              origin,
              goal,
              budgetMin,
              departureAt,
              walkCache,
              trainBoardSearch,
              boardSearchRoundOf,
            ),
        );
      }
      if (busBase !== null) {
        // バス corridor は基準になったのがここが初めてなので、途中乗降ハイブリッドも
        // ここで作る（通常照会の base と違い、事前に作る機会がなかった）。
        systems.push(
          (async (): Promise<RouteCandidate[]> => {
            this.diag.log(() => 'バス corridor を基準に徒歩最大化（#251）');
            return [
              ...(await this.buildCorridorHybrids(
                busBase,
                origin,
                goal,
                budgetMin,
                departureAt,
                measured,
              )),
              ...(await this.buildBoardSearchCandidate(
                busBase,
                origin,
                goal,
                budgetMin,
                departureAt,
                walkCache,
                busBoardSearch,
                boardSearchRoundOf,
              )),
            ];
          })(),
        );
      }
      const builtPerSystem = await Promise.all(systems);
      // 電車系の探索結果は base（＝`bases[0]`）のコリドー由来なので、その base が第2波
      // 由来ならここで生まれた候補も第2波由来（#376 の `arrivalWaveWon`）。先頭が電車系
      // なのは上の push 順が保証する。
      if (base !== null && arrivalWaveOptions.has(base)) {
        for (const c of builtPerSystem[0]) fromArrivalWave.add(c);
      }
      const extra = builtPerSystem.flat();
      metrics.recordBoardSearches([
        ...(base !== null ? [trainBoardSearch] : []),
        ...(busBase !== null ? [busBoardSearch] : []),
      ]);
      if (extra.length > 0) {
        this.diag.log(() => `徒歩最大化候補: ${extra.length}件をプールへ追加`);
        // 既に引いたバス候補（あれば）も再選定のプールへ引き継ぐ。board-search 候補が
        // 逆戻り・乗り遅れ・幽霊便で全滅したとき、last-resort で見つけた予算内のバスへ
        // 戻れるようにするため。
        enrichSw.start();
        selected = await this.selectAndEnrich(
          [...candidates, ...(busCandidates ?? []), ...extra],
          budgetMin,
          departureAt,
          {
            origin,
            goal,
            walkCache,
            enrichedCache,
            enrichLedger,
            bestEffortLedger,
            lastResortBus,
            prefetchBus,
          },
        );
        enrichSw.stop();
        this.diag.log(
          () =>
            'selected(after board-search): ' +
            `${this.diag.candLine(selected.enriched, budgetMin, departureAt)}`,
        );
      } else {
        this.diag.log(() => '徒歩最大化候補: なし');
      }
      // 確定候補が board-search 由来かを同一性で引く。best-effort 縮退は実時刻を当てた
      // コピーを作るため切れる——その場合の 0 は「無駄だった」ではなく「特定不能」。
      metrics.boardSearchWinnerRound =
        boardSearchRoundOf.get(selected.chosen) ?? 0;
      metrics.boardSearchMs = boardSw.elapsedMilliseconds;
    } else if (base !== null || busBase !== null) {
      this.diag.log(() => 'collapse=false → フォールバック起動せず');
    }
    if (trainBoardSearchFuture !== null && !collapse) {
      // 見込みが外れた（#341）。結果は誰も使わないので新ラウンドを起こさせない。
      // 進行中のラウンドまでは止められないが、`plan()` を抜けた直後に検索スコープの
      // クライアントが閉じられて in-flight は切れる（#259）。
      speculationAbandoned = true;
      this.diag.log(() => '投機 board-search 空振り: collapse=false → 打ち切り');
    }

    // 確定候補が第2波（#376）由来かも同一性で引く。
    metrics.arrivalWaveWon = fromArrivalWave.has(selected.chosen);

    // 崩壊後の再選定も同じ台帳へ積むので、畳むのは board-search を抜けた後。
    metrics.enrichMs = enrichSw.elapsedMilliseconds;
    metrics.recordEnrich(enrichLedger);
    metrics.recordBestEffort(bestEffortLedger);

    const finalizeSw = startedStopwatch();
    const named = await this.finalizeStationNames(selected.enriched, departureAt);
    metrics.finalizeMs = finalizeSw.elapsedMilliseconds;
    // 定性ログ（下の FINAL）は debug 限定なので、profile の計測では最終徒歩が読めない。
    metrics.finalWalkMinutes = named.walkMinutes;
    // 空振りの対価は**最後に読む**（#341）。打ち切りは新ラウンドを止めるだけなので、
    // 打ち切り時点で進行中だったラウンドの probe は駅名復元の裏で発行され終える。
    if (speculationAbandoned) {
      metrics.recordSpeculationWaste(trainBoardSearch);
      this.diag.log(
        () => `投機 board-search 空振りの対価: probe ${trainBoardSearch.probes}本`,
      );
    }
    this.diag.log(
      () => `=== FINAL: ${this.diag.candLine(named, budgetMin, departureAt)} ===`,
    );

    return this.build(named, departure, budgetMin, ctx.onProgress, {
      fromName: ctx.fromName,
      toName: ctx.toName,
    });
  }

  /// last-resort のバス option（#250）。`avoidModes` からバスを外して door-to-door を1回だけ
  /// 引き直し、**バス区間を含む option だけ**を返す。取得失敗は空リスト。
  ///
  /// [RouteCandidate] ではなく [TransitOption] を返すのは、コリドー座標を残して徒歩最大化の
  /// 基準に据えられるようにするため（#251）。
  private async fetchBusOptions(
    origin: GeoPoint,
    goal: GeoPoint,
    departureAt: Date,
  ): Promise<TransitOption[]> {
    this.diag.log(() => 'バス last-resort: avoidModes からバスを外して再照会');
    let body: JsonMap;
    try {
      body = await this.api.fetchGuidanceAt(origin, goal, departureAt, {
        allowBus: true,
      });
    } catch (error) {
      if (!(error instanceof RouteException)) throw error;
      this.diag.log(() => `バス last-resort: 再照会失敗 (${error.status})`);
      return [];
    }
    return parseGuidancePlan(body).filter((o) =>
      o.segments.some((s) => s.type === SegmentType.bus),
    );
  }

  /// 確定経路の transit 区間に乗降地名が無い（コリドー座標由来の候補）ときだけ、その乗車座標
  /// →降車座標で `/guidance/plan` を1回引き直して leg の実駅名・バス停名を復元する。
  /// 続けて隣接徒歩区間の端点へ地名を伝播する。バス区間も対象にする（#251）。
  private async finalizeStationNames(
    chosen: RouteCandidate,
    departureAt: Date,
  ): Promise<RouteCandidate> {
    const segs = [...chosen.segments];
    // 区間ごとの照会は互いに独立なので並列に投げる（#304）。実時刻解決と違い boardAt の
    // 累積依存が無く、全区間を departureAt で引くため直列にする理由がない。
    const targets: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      if (
        segs[i].type !== SegmentType.walk &&
        (segs[i].fromName.length === 0 || segs[i].toName.length === 0) &&
        segs[i].polyline.length >= 2
      ) {
        targets.push(i);
      }
    }
    const fetched = await Promise.all(
      targets.map((i) =>
        this.fetchTransitEndpoints(
          segs[i].polyline[0],
          segs[i].polyline[segs[i].polyline.length - 1],
          departureAt,
          {
            type: segs[i].type,
            line: segs[i].line,
            needFrom: segs[i].fromName.length === 0,
            needTo: segs[i].toName.length === 0,
            // 読むのは駅名だけ。時刻の妥当性で絞ると名前の候補が減るだけになる。
            requireTimetable: false,
          },
        ),
      ),
    );
    for (let k = 0; k < targets.length; k++) {
      const names = fetched[k];
      if (names === null) continue;
      const i = targets[k];
      segs[i] = segs[i].copyWith({
        fromName: segs[i].fromName.length === 0 ? names.from : undefined,
        toName: segs[i].toName.length === 0 ? names.to : undefined,
      });
    }
    this.propagateStationNames(segs);
    return new RouteCandidate({ from: chosen.from, to: chosen.to, segments: segs });
  }

  /// 乗車座標 [board]→降車座標 [alight] を [at] 発で引き直し、その区間を1本で結ぶ option の
  /// 乗降地名・実発着時刻を返す。該当 option が無い・取得失敗なら null。
  ///
  /// 照会モードと拾う leg の型は必ず `type` で揃える（#250）。応答の中の**どの option を
  /// 採るか**も揃える必要がある（#343）：先頭1本を無条件に採ると、遅い便の時刻をこの区間の
  /// 実時刻として貼り、乗れる候補が乗り遅れ・予算超過に見える。
  ///
  /// `line` には元区間の路線名を渡す。同じ駅間を複数の路線が走ることは珍しくないので、
  /// 種別だけで絞ると速い別路線の便が勝つ。一致する便が無ければ絞らない。
  ///
  /// `needFrom`・`needTo` には**駅名の復元が目的の呼び出し**で「実際に欠けている側」を渡す。
  /// **両側とも名前を持つことを要求してはならない**——片側だけ欠けた区間で、必要な側だけを
  /// 持つ便を捨ててしまう。実時刻検証はどちらも立てない：あちらの目的は時刻で、名前のために
  /// 遅い便を選ぶと到着が実際より遅く出る。
  ///
  /// `requireTimetable` は返り値の時刻を使う呼び出しだけで立てる（既定）。駅名復元は
  /// dep/arr を一切読まないので、そこで時刻の妥当性を要求すると**名前は正しいが時刻を欠く
  /// 便**を落とすだけになる。なお最後の到着順位付け（[earliestArrival]）は内部で
  /// [comparableFrom] を通すので、同条件で並んだときは時刻の揃った便が優先される。
  private async fetchTransitEndpoints(
    board: GeoPoint,
    alight: GeoPoint,
    at: Date,
    options: {
      type?: SegmentType;
      line?: string | null;
      needFrom?: boolean;
      needTo?: boolean;
      requireTimetable?: boolean;
    } = {},
  ): Promise<{
    from: string;
    to: string;
    dep: Date | null;
    arr: Date | null;
  } | null> {
    const type = options.type ?? SegmentType.train;
    const line = options.line ?? null;
    const needFrom = options.needFrom ?? false;
    const needTo = options.needTo ?? false;
    const requireTimetable = options.requireTimetable ?? true;

    let body: JsonMap;
    try {
      body = await this.api.fetchGuidanceAt(board, alight, at, {
        allowBus: type === SegmentType.bus,
      });
    } catch (error) {
      if (!(error instanceof RouteException)) throw error;
      return null;
    }
    // 拾う option は「[type] の区間**1本だけ**で goal まで行くもの」に限る。返す値は1区間
    // ぶんの乗降地名と実発着時刻として使われるので、それ以外を採ると**返り値に写らない
    // 区間の時間が消える**。
    const direct = parseGuidancePlan(body).filter(
      (o) =>
        o.segments.filter((s) => s.type === type).length === 1 &&
        o.segments.every((s) => s.type === type || s.type === SegmentType.walk),
    );
    // 時刻の妥当性は**徒歩で絞る前に**見る。順序が逆だと、壊れた便が最小徒歩を占めた
    // ときにまともな便が先に消え、残った壊れた便を [comparableFrom] の縮退が拾ってしまう。
    const comparable = requireTimetable
      ? this.comparableFrom(direct, at)
      : direct;
    // 元区間と同じ路線の便を優先する。一致が無ければ絞らない。
    const sameLine = comparable.filter(
      (o) => firstOfType(o, type).line === line,
    );
    const cands =
      line === null || line.length === 0 || sameLine.length === 0
        ? comparable
        : sameLine;
    // 徒歩で別駅へ回る便を採ると、その徒歩も返り値から落ちて区間の所要から消える。
    // 徒歩0を要求せず最小を採るのは、照会の端点がコリドー座標＝実駅とわずかにずれるため
    // 上流が数分の access/egress を必ず付けるから（そこで弾くと駅名復元ごと失う）。
    //
    // 分へ丸めた値で比べる（パーサが `(secs / 60).round()` する）。同じ丸め分に並ぶ便
    // どうしの徒歩差は定義上60秒未満で、駅間ではなく同一駅の出入口ぶんの距離しかない。
    const walkMinutesOf = (o: TransitOption): number =>
      o.segments
        .filter((s) => s.type === SegmentType.walk)
        .reduce((a, s) => a + s.minutes, 0);
    let leastWalk: number | null = null;
    for (const o of cands) {
      const w = walkMinutesOf(o);
      if (leastWalk === null || w < leastWalk) leastWalk = w;
    }
    const shortest = cands.filter((o) => walkMinutesOf(o) === leastWalk);
    // 駅名が目的の呼び出しでは、**欠けている側を埋められる**便を先に見る（無ければ絞らない）。
    //
    // 徒歩最小より**後**に適用するのは意図的。この照会の option はすべて同じ座標から始まる
    // ので、access が余分にある便は**別の駅から乗る**便＝その乗車地名は区間ジオメトリの
    // 起点の駅名ではない。**空欄より誤りの方が悪い。**
    const fillsNeeded = (o: TransitOption): boolean => {
      const leg = firstOfType(o, type);
      return (
        (!needFrom || leg.fromName.length > 0) &&
        (!needTo || leg.toName.length > 0)
      );
    };
    const named = shortest.filter(fillsNeeded);
    const best = this.earliestArrival(named.length > 0 ? named : shortest, at);
    if (best === null) return null;
    const leg = firstOfType(best, type);
    return {
      from: leg.fromName,
      to: leg.toName,
      dep: leg.depTime,
      arr: leg.arrTime,
    };
  }

  /// approach A（時刻なしハイブリッドの実時刻検証）。コリドー由来の電車区間は距離概算の
  /// minutes だけを持ち depTime を欠くため、乗車待ち（終電後・運行時間外の翌朝始発待ちを
  /// 含む）が [arrivalMinutes] に反映されず、走っていない電車が予算内へ化ける（#137）。
  /// 採用候補の時刻なし transit 区間について、乗車座標→降車座標を実 boardAt で引き直し、
  /// 最初の同種 leg の実発着時刻を当てる。boardAt より前発・取得失敗・同種の便なしの区間は
  /// 当てない。駅名も同時に復元する。バス区間も同じ検証に掛ける（#250）。
  private async resolveBoardingTimes(
    cand: RouteCandidate,
    departureAt: Date,
    onRedraw?: () => void,
  ): Promise<RouteCandidate> {
    const segs = [...cand.segments];
    let changed = false;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.type === SegmentType.walk) continue;
      if (seg.depTime !== null) continue; // 既に実時刻あり（標準乗換・board-search）
      if (seg.polyline.length < 2) continue;
      const cumBefore = arrivalMinutes(segs.slice(0, i), departureAt);
      const boardAt = plusMinutes(departureAt, cumBefore);
      // 区間間は並列化しない（#163 対象外）: 後続区間の boardAt が前区間で解決した実乗車
      // 時間・乗車待ちに依存するため、直列でないと照会時刻がずれる。この直列段数が enrich の
      // 壁時計を決めるので計上する（[EnrichLatencyLedger]）。
      onRedraw?.();
      const ep = await this.fetchTransitEndpoints(
        seg.polyline[0],
        seg.polyline[seg.polyline.length - 1],
        boardAt,
        { type: seg.type, line: seg.line },
      );
      if (ep === null || ep.dep === null) continue;
      if (ep.dep.getTime() < boardAt.getTime()) continue;
      const ride =
        ep.arr !== null && ep.arr.getTime() >= ep.dep.getTime()
          ? Math.trunc((ep.arr.getTime() - ep.dep.getTime()) / 60000)
          : seg.minutes;
      segs[i] = seg.copyWith({
        fromName: seg.fromName.length === 0 ? ep.from : undefined,
        toName: seg.toName.length === 0 ? ep.to : undefined,
        depTime: ep.dep,
        arrTime: ep.arr ?? undefined,
        minutes: ride,
      });
      changed = true;
    }
    if (!changed) return cand;
    return new RouteCandidate({ from: cand.from, to: cand.to, segments: segs });
  }

  /// transit 区間の乗降地名を、直前（乗車側）・直後（降車側）の徒歩区間の端点が空のときだけ
  /// 写す。タイムラインの乗車ノードは直前徒歩の toName、降車後の徒歩は fromName を place に
  /// 使うため。出発地・目的地の端（非空）は上書きしない。
  private propagateStationNames(segs: RouteSegment[]): void {
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].type === SegmentType.walk) continue;
      const board = segs[i].fromName;
      const alight = segs[i].toName;
      if (
        i > 0 &&
        segs[i - 1].type === SegmentType.walk &&
        segs[i - 1].toName.length === 0 &&
        board.length > 0
      ) {
        segs[i - 1] = segs[i - 1].copyWith({ toName: board });
      }
      if (
        i + 1 < segs.length &&
        segs[i + 1].type === SegmentType.walk &&
        segs[i + 1].fromName.length === 0 &&
        alight.length > 0
      ) {
        segs[i + 1] = segs[i + 1].copyWith({ fromName: alight });
      }
    }
  }

  /// 候補1件を実測（enrich 徒歩＋実発車時刻解決）し、identity でメモ化する（#315）。
  /// [RouteCandidate] は値等価を持たないので Map は同一インスタンス単位で畳む。
  private async measureCandidate(
    c: RouteCandidate,
    departureAt: Date,
    walkCache: WalkLegCache,
    enrichedCache: Map<RouteCandidate, RouteCandidate>,
    ledger: EnrichLatencyLedger,
  ): Promise<RouteCandidate> {
    const hit = enrichedCache.get(c);
    // キャッシュヒットは壁時計を払っていないので台帳へ入れない。入れると「本数×段数」の
    // 分母が水増しされ、ファンアウトの実コストを読み違える。
    if (hit !== undefined) return hit;
    const sw = startedStopwatch();
    // 徒歩 enrich と引き直しは厳密な直列なので、内側の await を別時計で挟むだけで内訳が割れる。
    const walkSw = startedStopwatch();
    let steps = 0;
    try {
      const walked = await this.enrichWalkGeometry(c, walkCache);
      walkSw.stop();
      const e = await this.resolveBoardingTimes(walked, departureAt, () => {
        steps++;
      });
      sw.stop();
      ledger.record({
        chainMs: sw.elapsedMilliseconds,
        walkMs: walkSw.elapsedMilliseconds,
        resolveSteps: steps,
      });
      enrichedCache.set(c, e);
      return e;
    } catch (error) {
      // 離脱した検索の計上は無意味（metrics ごと捨てる）。
      if (error instanceof SearchCanceledException) throw error;
      // 壊れた応答で落ちる候補（[measureOrDrop] が null にする）も、そこまでの壁時計は
      // 並列パスの待ち時間として払っている。計上しないと**上流が壊れているときほど
      // 臨界パスが小さく出る**という逆向きの歪みが入り、障害時ほど実態が読めなくなる。
      sw.stop();
      walkSw.stop();
      ledger.record({
        chainMs: sw.elapsedMilliseconds,
        walkMs: walkSw.elapsedMilliseconds,
        resolveSteps: steps,
      });
      throw error;
    }
  }

  /// 候補**間**並列（#315）の実測を候補単位で隔離する。壊れた応答は null にして当該候補
  /// だけ落とすが、[SearchCanceledException] だけは飲まず伝播させる——並列ファンアウトで
  /// キャンセルを握り潰すと、離脱後も残りの実測が走り続け plan() が停止できない。
  private async measureOrDrop(
    c: RouteCandidate,
    departureAt: Date,
    walkCache: WalkLegCache,
    enrichedCache: Map<RouteCandidate, RouteCandidate>,
    ledger: EnrichLatencyLedger,
  ): Promise<RouteCandidate | null> {
    try {
      return await this.measureCandidate(
        c,
        departureAt,
        walkCache,
        enrichedCache,
        ledger,
      );
    } catch (error) {
      if (error instanceof SearchCanceledException) throw error;
      return null;
    }
  }

  /// 候補から決定的に選定し、採用1経路を Google 実測（enrich）で検証する確定ループ。
  /// **乗り遅れ再照会（#115）は行わない**：enrich で (a) 予算超過、または (b) 先頭電車に
  /// 乗り遅れが判明した候補は除外して乗れる次善へ選び直す。除外しきれないときは確定させず
  /// best-effort へ縮退する（#254）。
  ///
  /// `lastResortBus` を渡すと、縮退した best-effort が**なお予算外か乗り遅れる**ときに限り
  /// 呼び、得られた候補をプールへ足して選定をやり直す（#250）。
  private async selectAndEnrich(
    candidates: RouteCandidate[],
    budgetMin: number,
    departureAt: Date,
    ctx: {
      origin: GeoPoint;
      goal: GeoPoint;
      walkCache: WalkLegCache;
      enrichedCache: Map<RouteCandidate, RouteCandidate>;
      enrichLedger: EnrichLatencyLedger;
      bestEffortLedger: BestEffortLedger;
      lastResortBus?: () => Promise<RouteCandidate[]>;
      prefetchBus?: () => void;
    },
  ): Promise<Selection> {
    const { origin, goal, walkCache, enrichedCache, enrichLedger, bestEffortLedger } =
      ctx;

    /// 縮退。まず従来どおり best-effort を求め、それでも予算外ならバス許容の再照会を
    /// 一度だけ試して候補を足し、選定をやり直す（#250）。
    ///
    /// 「予算内候補なし」で即バスを引かないのは、enrich でプールの見積り予算内候補が
    /// すべて落ちた後にもこの分岐へ来るため。判定は「best-effort が実測で使い物になるか」。
    ///
    /// 「使い物になる」は到着が予算内であることに加え、乗り遅れが無いこと。[arrivalMinutes]
    /// は乗り遅れた便を「待ち0で予定どおり乗車」と楽観近似して進めるため、実測徒歩で発車後に
    /// 駅着する経路が予算内に見えてしまう（#250 レビュー指摘）。
    const giveUp = async (): Promise<Selection> => {
      // バス照会は best-effort の結果に依存しない（依存するのは採用の可否だけ）ので、
      // 判断を待たずに発行して直列の段を重ねる。
      ctx.prefetchBus?.();
      const fallback = await this.bestEffortResolved(
        candidates,
        budgetMin,
        departureAt,
        walkCache,
        bestEffortLedger,
      );
      const segs = fallback.enriched.segments;
      const arrival = arrivalMinutes(segs, departureAt);
      const missed = firstMissedTransit(segs, departureAt) !== null;
      if (ctx.lastResortBus === undefined) return fallback;
      if (arrival <= budgetMin && !missed) {
        this.diag.log(
          () => `  → best-effort が予算内(arr=${arrival}m) → バス再照会せず`,
        );
        return fallback;
      }
      const bus = await ctx.lastResortBus();
      // 再入時（バス追加後の選び直しから再び縮退したとき）に同じ候補を積み増さない。
      const fresh = bus.filter((b) => !candidates.some((c) => c === b));
      if (fresh.length === 0) {
        this.diag.log(() => '  → 追加できるバス候補なし → best-effort のまま');
        return fallback;
      }
      this.diag.log(
        () =>
          '  → best-effort が' +
          `${missed ? '乗り遅れ' : `予算外(arr=${arrival}m)`}` +
          ` → バス候補 ${fresh.length}件をプールへ追加して選び直し（last-resort）`,
      );
      return this.selectAndEnrich(
        [...candidates, ...fresh],
        budgetMin,
        departureAt,
        {
          origin,
          goal,
          walkCache,
          enrichedCache,
          enrichLedger,
          bestEffortLedger,
        },
      );
    };

    // 見積り予算内候補を短リスト化。逆戻り除外＋予算内フィルタ＋選好順は先行実測
    // （Option A・#318）と同一の [measureShortlist] を用いる——両者がずれると先行実測で
    // 温めたキャッシュがここでヒットせず1パスへ畳めない。
    const within = measureShortlist({
      candidates,
      budgetMin,
      departureAt,
      origin,
      goal,
    });
    if (within.length === 0) {
      this.diag.log(
        () => '  → 見積り予算内候補なし → best-effort 縮退（予算外ならバス last-resort）',
      );
      return giveUp();
    }

    // 短リストを候補**間**並列で実測する（#315）。まず最上位の徒歩tier だけを測る——
    // [selectBestRoute] は徒歩最大を勝者にするので、共通ケースはこの1バッチで済み IO 最小。
    // 最上位 tier が全滅したら、残りを**1回の並列バッチ**で一括実測する（#315 B）。
    const rejected = new Set<RouteCandidate>();
    const cap = Math.min(within.length, maxMeasureShortlist);
    const firstTierWalk = within[0].walkMinutes;
    let firstTierEnd = 0;
    while (firstTierEnd < cap && within[firstTierEnd].walkMinutes === firstTierWalk) {
      firstTierEnd++;
    }
    const ranges: [number, number][] = [[0, firstTierEnd]];
    if (firstTierEnd < cap) ranges.push([firstTierEnd, cap]);
    for (const range of ranges) {
      const batch = within.slice(range[0], range[1]);
      this.diag.log(() =>
        range[0] === 0
          ? `measure tier: walk=${firstTierWalk}m ${batch.length}件を候補間並列で実測`
          : `reject後の残り予算内候補 ${batch.length}件を1並列バッチで一括実測（#315 B）`,
      );
      // 候補単位で隔離して一括実測する。壊れた応答1件（非勝者）で Promise.all が plan()
      // 全体を落とさないよう、失敗候補は null（棄却扱い）に落とす。
      const enriched = await Promise.all(
        batch.map((c) =>
          this.measureOrDrop(c, departureAt, walkCache, enrichedCache, enrichLedger),
        ),
      );
      // tier バッチは直列に降りるので、バッチ境界＝パス境界。
      enrichLedger.endPass();
      let winnerIdx: number | null = null;
      for (let k = 0; k < batch.length; k++) {
        const e = enriched[k];
        if (e === null) {
          this.diag.log(
            () =>
              `  → 棄却(実測失敗): ${this.diag.candLine(batch[k], budgetMin, departureAt)}`,
          );
          rejected.add(batch[k]);
          continue;
        }
        const v = invariantViolation(e.segments, budgetMin, departureAt);
        if (v.overBudget || v.missed || v.unverified) {
          this.diag.log(
            () =>
              '  → 棄却(' +
              `${v.overBudget ? '予算超過' : v.missed ? '乗り遅れ' : '未確認便'}` +
              `): ${this.diag.candLine(e, budgetMin, departureAt)}`,
          );
          rejected.add(batch[k]);
        } else {
          // batch は選好順（徒歩降順→到着昇順）なので最初の生存者が徒歩最大＝勝者。
          winnerIdx ??= k;
        }
      }
      if (winnerIdx !== null) {
        const chosen = batch[winnerIdx];
        const enrichedWinner = enriched[winnerIdx]!;
        this.diag.log(
          () => `  → 確定: ${this.diag.candLine(enrichedWinner, budgetMin, departureAt)}`,
        );
        return { chosen, enriched: enrichedWinner };
      }
    }
    // 予算内 tier をすべて測っても生存者なし（または短リスト上限）→ best-effort へ縮退する
    // （#254）。ここも [giveUp] を通す＝best-effort が予算外のときだけバスを引く（#250）。
    this.diag.log(
      () => '  → 予算内候補が実測で全滅 → best-effort 縮退（予算外ならバス last-resort）',
    );
    return giveUp();
  }

  /// best-effort 縮退（#121／#137 深夜）。候補へ実発車時刻を当て（approach A）、引き直しでも
  /// 実時刻を確認できなかった時刻なし transit 区間を含む候補（幻便・幽霊バス）を除いたうえで
  /// 「今夜乗れる範囲の実到着最早」を選ぶ。検証済みが皆無なら元の解決済み候補へ戻す。
  ///
  /// 選んだ候補は enrich してから**乗り遅れを測り直す**（#254）。[bestEffort] 内の
  /// [reachableWithinBudget] は guidance 見積り徒歩に対して [firstMissedTransit] を見るため、
  /// 実街路で徒歩が伸びて発車後に駅着する経路を通してしまう。
  ///
  /// ここに [maxMeasureShortlist] のような試行上限は**置かない**。プールは毎反復で厳密に
  /// 1件減るため停止性は長さが保証しており、上限は「全徒歩へ到達する前に打ち切って乗り遅れ
  /// 経路を返す」＝この修正が拠って立つ不変条件を壊す方向にしか働かない。
  private async bestEffortResolved(
    candidates: RouteCandidate[],
    budgetMin: number,
    departureAt: Date,
    walkCache: WalkLegCache,
    ledger: BestEffortLedger,
  ): Promise<Selection> {
    ledger.enter();
    const sw = startedStopwatch();
    // 候補ごとの実時刻解決は互いに独立なので並列に投げる（#163）。候補内の区間ループは
    // 後続区間の boardAt が前区間の解決済み実乗車時間に依存するため直列のまま。
    const depths = new Array<number>(candidates.length).fill(0);
    const resolved = await Promise.all(
      candidates.map((c, i) =>
        this.resolveBoardingTimes(c, departureAt, () => {
          depths[i]++;
        }),
      ),
    );
    ledger.recordPool({
      candidates: candidates.length,
      resolveDepth: depths.length === 0 ? 0 : Math.max(...depths),
    });
    const verified = resolved.filter((c) => !hasUnverifiedTransit(c.segments));
    let pool = verified.length > 0 ? verified : resolved;
    for (;;) {
      const fallback = bestEffort(pool, budgetMin, departureAt);
      const enriched = await this.enrichWalkGeometry(fallback, walkCache);
      const missed = firstMissedTransit(enriched.segments, departureAt) !== null;
      // 予算超過では除外しない：best-effort は「予算内が無いとき」の縮退先なので、超過は
      // 想定内で最早到着こそが選定基準。乗り遅れ（＝そもそも乗れない）だけを除外する。
      if (!missed || pool.length === 1) {
        if (missed) {
          this.diag.log(
            () =>
              '  → best-effort: 乗り遅れない候補が尽きた（最後の1件）→ ' +
              `そのまま縮退: ${this.diag.candLine(enriched, budgetMin, departureAt)}`,
          );
        }
        ledger.addMs(sw.elapsedMilliseconds);
        return { chosen: fallback, enriched };
      }
      this.diag.log(
        () =>
          '  → best-effort: enrich実測で乗り遅れ→除外して選び直し: ' +
          `${this.diag.candLine(enriched, budgetMin, departureAt)}`,
      );
      ledger.recordRetry();
      pool = pool.filter((c) => c !== fallback);
    }
  }

  /// 確定 [winner] が徒歩最大化の崩壊（§7）かを判定する。(1) 予算内標準乗換の最大徒歩を
  /// [collapseWalkMarginMin] 以下しか上回らない、(2) 予算を相対または絶対のいずれかの閾値
  /// 以上余らせている、の両方を満たすとき true。best-effort（予算外）は対象外。
  ///
  /// [options] は「[winner] が属する door-to-door 候補群」を渡す（#251）。含めないと予算内の
  /// 電車が無い状況で `bestStandardWalk=0` となり、バスのアクセス徒歩がそのまま margin に
  /// なって崩壊が不成立になる。
  private isCollapse(
    winner: RouteCandidate,
    options: TransitOption[],
    budgetMin: number,
    departureAt: Date,
  ): boolean {
    const arrival = arrivalMinutes(winner.segments, departureAt);
    if (arrival > budgetMin) {
      this.diag.log(
        () => `collapse判定: 予算外(arr=${arrival}m>budget=${budgetMin}m)→対象外`,
      );
      return false;
    }
    const slack = budgetMin - arrival;
    const relativeThreshold = budgetMin * collapseSlackRatio;
    // 相対（予算の割合）・絶対（分）のいずれかを満たせば「予算が大きく余っている」。
    if (slack < relativeThreshold && slack < collapseSlackMinutes) {
      this.diag.log(
        () =>
          `collapse判定: 症状(2)未達 slack=${slack}m < ` +
          `相対閾値=${relativeThreshold.toFixed(1)}m` +
          `(=${budgetMin}m×${collapseSlackRatio}) かつ < ` +
          `絶対閾値=${collapseSlackMinutes}m →起動せず`,
      );
      return false;
    }
    let bestStandardWalk = 0;
    for (const o of options) {
      const c = new RouteCandidate({ from: o.from, to: o.to, segments: o.segments });
      if (
        arrivalMinutes(c.segments, departureAt) <= budgetMin &&
        c.walkMinutes > bestStandardWalk
      ) {
        bestStandardWalk = c.walkMinutes;
      }
    }
    const margin = winner.walkMinutes - bestStandardWalk;
    const result = margin <= collapseWalkMarginMin;
    this.diag.log(
      () =>
        `collapse判定: slack=${slack}m(≥閾値) ` +
        `winnerWalk=${winner.walkMinutes}m bestStandardWalk=${bestStandardWalk}m ` +
        `margin=${margin}m ${result ? '≤' : '>'} ${collapseWalkMarginMin} ` +
        `→症状(1)=${result ? '達' : '未達'} → collapse=${result}`,
    );
    return result;
  }

  /// 乗車駅探索（docs/spec/route-optimization.md §3.6 / §2.3）。
  /// [base] のコリドー座標を乗車駅候補（前半徒歩 t1 の昇順）とし、各点 X から
  /// `/guidance/plan(X→goal, departureAt+t1)` を引き直して「到着が予算内の最遠＝総徒歩
  /// 最大」を [maxWalkBoardingIndexParallel] で探索する。
  ///
  /// **前半徒歩は Google 実街路で実測して探索を駆動する（#137 主因の修正）。** 直線推定は
  /// 実街路に対し大きく楽観に倒れることがあり（実機で -36分・25%）、それで駆動すると目的地
  /// 寄りの遠い乗車駅へ収束→実街路では全部予算超過→徒歩最小の標準乗換へ崩落していた。
  ///
  /// **戻り値は探索が評価した予算内候補を「全部」返す（#137）。** 単一の最良1本だけを返すと、
  /// 下流の逆戻りフィルタ・乗り遅れ除外で消えたとき次善へ落ちられず徒歩最小へ転落する。
  private async buildBoardSearchCandidate(
    base: TransitOption,
    origin: GeoPoint,
    goal: GeoPoint,
    budgetMin: number,
    departureAt: Date,
    walkCache: WalkLegCache,
    stats: BoardSearchStats,
    roundOf: Map<RouteCandidate, number>,
    abandoned?: () => boolean,
  ): Promise<RouteCandidate[]> {
    const stops = this.corridorStops(base);
    if (stops.length < 2) return [];
    // 締切切れなら scan/probe を一切起こさず縮退する（#317 レビュー対応）。先頭の matrix
    // プレ実測（proxy・deadlineApplies:false）は締切に縛られず走ってしまうため、探索自体を
    // 起こさないのが正しい縮退。
    if (this.deadline.isExpired) {
      this.diag.log(() => 'board-search: 締切切れのため起動せず縮退');
      return [];
    }
    // 引き直しの照会モードは基準コリドーの種別に揃える（#251）。
    const allowBus = base.segments.some((s) => s.type === SegmentType.bus);

    // #317: 全コリドー点の前半徒歩 t1 を matrix 一括実測し、t1 単独で予算外の遠点を探索範囲
    // から刈る。刈っても予算内候補は落ちない（[walkFeasiblePrefixCount] の安全上界）。
    const scanCount = await this.boardSearchScanCount(origin, stops, budgetMin);
    stats.scanCount = scanCount;
    if (scanCount === 0) {
      this.diag.log(() => 'board-search: 予算内の乗車駅なし（t1 実測で全点予算外）');
      return [];
    }

    // 探索が同じ index を再評価しても引き直さないようメモ化する。
    const built = new Map<number, RouteCandidate | null>();
    // 引き直しが**上流の失敗**（429・5xx・TIMEOUT）で落ちた index。`built` の null は
    // 「経路が無い」と「評価できなかった」の両方になるが、探索に対する意味は正反対（#333）。
    const unevaluated = new Set<number>();

    /// 評価済みで予算内だった候補の最大徒歩（見積り・分）。皆無なら 0。
    const bestWalkSoFar = (): number => {
      let best = 0;
      for (const c of built.values()) {
        if (c === null) continue;
        if (arrivalMinutes(c.segments, departureAt) > budgetMin) continue;
        if (c.walkMinutes > best) best = c.walkMinutes;
      }
      return best;
    };

    // index → 何ラウンド目の probe が作ったか。`onRound` がラウンド開始時に rounds を
    // 進めるので、probe の**開始時点**の値がそのラウンド番号になる。
    const builtInRound = new Map<number, number>();
    const buildAt = async (i: number): Promise<RouteCandidate | null> => {
      if (built.has(i)) return built.get(i)!;
      builtInRound.set(i, stats.rounds);
      // 発行時点で数える。完了時に数えると、締切・キャンセル・投機の打ち切りで捨てた
      // probe が本数から漏れ、上流へ実際に払った往復を過小に見積もる。
      stats.probes++;
      const x = stops[i];
      // 前半徒歩は実測（失敗時のみ直線推定へフォールバック）。
      const walkSw = startedStopwatch();
      const measuredWalk = await this.tryWalk(origin, x.coord, base.from, '', walkCache);
      walkSw.stop();
      // 実測が落ちたら直線推定へ縮退する。ただし直線は実街路に対し大きく楽観に倒れるので
      // （#137 実機で -36分・25%）、本来予算外の点が予算内に見えて境界が奥へ動き得る。
      if (measuredWalk === null) stats.probeFailed = true;
      const walk1 =
        measuredWalk ?? this.estimateWalk(origin, x.coord, base.from, '');
      const boardAt = plusMinutes(departureAt, walk1.totalMin);
      const guidanceSw = startedStopwatch();
      const options = await this.fetchTransitOptionsFrom(x.coord, goal, boardAt, {
        allowBus,
        onUpstreamFailure: () => {
          stats.probeFailed = true;
          unevaluated.add(i);
        },
      });
      guidanceSw.stop();
      // 引き直しが失敗した probe も計上する——照会は発行され、壁時計は払っている。
      stats.probeLatency.record({
        walkMs: walkSw.elapsedMilliseconds,
        guidanceMs: guidanceSw.elapsedMilliseconds,
      });
      if (options.length === 0) {
        this.diag.log(
          () =>
            `board-search i=${i} walk1=${walk1.totalMin}m guidance失敗` +
            `(${unevaluated.has(i) ? '上流エラー→未評価' : '経路なし→予算外扱い'})`,
        );
        built.set(i, null);
        return null;
      }
      const walk1Seg = walk1.segments[0];
      const cands = options.map(
        (o) =>
          new RouteCandidate({
            from: base.from,
            to: o.to,
            segments: [
              ...(walk1Seg.minutes > 0 ? [walk1Seg] : []),
              ...o.segments,
            ],
          }),
      );
      // 予算内に収まる便が複数あるなら**徒歩最大**を採る（目的関数）。予算内が皆無なら
      // **到着最早**を採る——この地点が予算外かの判定は最速便で決めなければ、悪い1本で
      // 探索範囲を切り捨てることになる（#343）。
      const withinHere = cands.filter(
        (c) => arrivalMinutes(c.segments, departureAt) <= budgetMin,
      );
      const earlier = (a: RouteCandidate, b: RouteCandidate): RouteCandidate => {
        const arrivalA = arrivalMinutes(a.segments, departureAt);
        const arrivalB = arrivalMinutes(b.segments, departureAt);
        if (arrivalA !== arrivalB) return arrivalA < arrivalB ? a : b;
        return a.transferCount <= b.transferCount ? a : b;
      };
      // 徒歩が並んだら到着最早・乗換少で割る（[selectBestRoute] と同じ順位付け）。同点を
      // 上流の並び順に委ねると、この issue が否定した「先頭が最良」を裏口から信じることになる。
      const cand =
        withinHere.length === 0
          ? cands.reduce(earlier)
          : withinHere.reduce((a, b) =>
              a.walkMinutes !== b.walkMinutes
                ? a.walkMinutes > b.walkMinutes
                  ? a
                  : b
                : earlier(a, b),
            );
      this.diag.log(
        () =>
          `board-search i=${i} walk1=${walk1.totalMin}m ` +
          `乗車駅=${this.diag.boardingStationOf(cand)} ` +
          `候補${cands.length}本(予算内${withinHere.length}) ` +
          `${this.diag.candLine(cand, budgetMin, departureAt)}`,
      );
      built.set(i, cand);
      return cand;
    };

    // 実測到着が index 単調増の前提で「到着が予算内の最遠 index ＝総徒歩最大」を探索。
    const best = await maxWalkBoardingIndexParallel({
      // matrix プレ実測で刈った予算内フロンティアまでを探索範囲にする（#317）。
      count: scanCount,
      budgetMin,
      fanout: boardSearchFanout,
      // ラウンド境界で台帳を締める。onRound はラウンド**開始時**に呼ばれるので、ここでの
      // endRound は直前のラウンドを畳む（1本目は空＝no-op）。最終ラウンドは締めない——
      // [ProbeLatencyLedger] のゲッタが進行中ぶんを含むため、締切 break でも落ちない。
      // 1本目は空（徒歩0）になるため、その1件は積まない。
      onRound: () => {
        if (stats.rounds > 0) stats.walkByRound.push(bestWalkSoFar());
        stats.rounds++;
        stats.probeLatency.endRound();
      },
      // 締切超過で新ラウンドを起こさない（#300）。ゲートが無いと探索はラウンドを回し続け、
      // 全 probe が即 TIMEOUT →「予算外」と解釈されて区間を縮める——実測ではなく締切で
      // 境界を決めることになる。
      shouldContinue: () => {
        // 投機起動の見込みが外れた（#341）。捨てると決めた探索に第三者 API の未知のレート枠
        // （§2.1）を焼かせ続けると、同じ枠を使う次の検索の board-search が浅くなる。
        // [BoardSearchStats.truncated] は立てない——捨てる探索の境界はそもそも報告されない。
        if (abandoned?.() ?? false) return false;
        if (!this.deadline.isExpired) return true;
        stats.truncated = true;
        return false;
      },
      evaluate: async (i) => {
        const c = await buildAt(i);
        if (c !== null) return arrivalMinutes(c.segments, departureAt);
        // 引けたが経路が無い点は予算外として扱い、手前の駅を探す。上流エラーで引けなかった
        // 点は「予算外」を意味しないので未評価（null）を返す（#333）。
        return unevaluated.has(i) ? null : budgetMin + (1 << 20);
      },
    });
    // 締切が**ラウンド実行中**に切れた場合、probe は TIMEOUT → 全 probe が未評価 →
    // [maxWalkBoardingIndexParallel] がそのラウンドで打ち切り、shouldContinue を再び
    // 通らずにループを抜ける。つまり「新ラウンドを起こさなかった」判定だけでは打ち切りを
    // 取りこぼす——境界を実測でなく締切が決めた、最も記録すべきケースで。
    if (this.deadline.isExpired) stats.truncated = true;
    // 最終ラウンドぶんを締める。ここを呼び出し側の義務にすると、締切 break で抜けた
    // ——最も測りたい重い探索——で系列が1つ短くなる。
    if (stats.rounds > 0) stats.walkByRound.push(bestWalkSoFar());
    // 探索が評価した点のうち、予算内の候補を「全部」返す。境界 best 1本だけでなく全部を
    // 返すのは：(1) 到着は実街路で非単調になり得るため境界＝徒歩最大とは限らず、(2) 採用前に
    // 逆戻りフィルタ・乗り遅れ除外で1本が消えても次善へ落とせるようにするため。
    const withinEntries = [...built.entries()].filter(
      ([, v]) =>
        v !== null && arrivalMinutes(v.segments, departureAt) <= budgetMin,
    ) as [number, RouteCandidate][];
    // 境界の計上は探索の戻り値ではなく**評価済みの予算内で最遠の index**。探索は最初の
    // 予算外 probe で結果の走査を打ち切るため、同一ラウンドでそれより奥に評価済みの
    // 予算内点があっても戻り値には現れない（#332 レビュー）。
    stats.best = withinEntries.reduce((m, [k]) => (k > m ? k : m), -1);
    this.diag.log(
      () =>
        'board-search: 実測k分割並列探索の境界 best=' +
        `${best === null ? 'null(予算内乗車駅なし)' : String(best)} / コリドー点${stops.length}` +
        ` / 予算内最遠=${stats.best}`,
    );
    const within = withinEntries.map(([, v]) => v);
    // 確定候補がどのラウンド由来かを後から引けるようにする。
    for (const [k, v] of withinEntries) {
      roundOf.set(v, builtInRound.get(k) ?? 0);
    }
    this.diag.log(() => `board-search: 予算内候補 ${within.length}件を返す`);
    return within;
  }

  /// コリドー全点の前半徒歩 t1 を matrix 一括実測し、探索を「t1 が予算内の最遠点」まで
  /// （先頭からの点数）に刈った値を返す（#317）。到着 = t1 + t2(≥0) なので t1 単独で予算外の
  /// 遠点は確実に予算外。matrix 欠落レッグは直線推定（実徒歩の下限）で埋める：下限すら予算外
  /// なら実測でも予算外なので刈って安全、下限が予算内なら刈らず探索の街路実測に委ねる。
  ///
  /// 目的地はサーバの `MATRIX_MAX_ELEMENTS`（25）を超えると 400 で全滅するため、
  /// [maxScanMatrixDests] 個以下ずつに分割し、チャンクは独立なので**並列**に投げる。
  /// 分割レスポンスの `destinationIndex` はチャンク内 0 起点なので、チャンク先頭を足して
  /// 大域 index へ戻す。
  private async boardSearchScanCount(
    origin: GeoPoint,
    stops: CorridorStop[],
    budgetMin: number,
  ): Promise<number> {
    const walk1 = stops.map((s) =>
      dartRound((haversineKm(origin, s.coord) * 1000) / walkMetersPerMinute),
    );
    const ranges: { start: number; end: number }[] = [];
    for (let start = 0; start < stops.length; start += maxScanMatrixDests) {
      ranges.push({
        start,
        end: Math.min(start + maxScanMatrixDests, stops.length),
      });
    }
    // チャンクは互いに独立なので並列に投げ、走時計を「最遅1本」に抑える（#317 レビュー対応）。
    const chunks = await Promise.all(
      ranges.map((r) =>
        this.api.fetchWalkMatrix(
          [origin],
          stops.slice(r.start, r.end).map((s) => s.coord),
        ),
      ),
    );
    for (let c = 0; c < ranges.length; c++) {
      const rows = chunks[c];
      if (rows === null) continue;
      const r = ranges[c];
      for (const e of rows) {
        if (!isRecord(e)) continue;
        const di = intOr(e['destinationIndex'], 0);
        const min = parseDurationMin(e['duration']);
        if (min === null || di < 0 || di >= r.end - r.start) continue;
        walk1[r.start + di] = min;
      }
    }
    return walkFeasiblePrefixCount(walk1, budgetMin);
  }

  /// 乗降アクセス徒歩を1回（最大2コール）のマトリクスで一括実測し、[measured] にレッグキー
  /// →徒歩分で格納する。goal を乗車側 destinations 末尾に相乗りさせ全徒歩(origin→goal)も
  /// 同時に測る。失敗レッグは未格納（直線推定へフォールバック）。
  private async measureAccessWalks(
    origin: GeoPoint,
    goal: GeoPoint,
    boardStops: GeoPoint[],
    alightStops: GeoPoint[],
    measured: Map<string, number>,
  ): Promise<void> {
    // 乗車側・降車側のマトリクスは互いに独立なので並列に投げる（#163）。
    //
    // 移植元は2本を順に await しているが、`Promise.all` で**両方に同時にハンドラを付ける**。
    // 片方ずつ await すると、先に待つ側が倒れた時点で関数を抜け、もう一方の拒否を誰も
    // 観測しないまま残る——キャンセルで共有クライアントを閉じると両方が
    // [SearchCanceledException] で倒れるので、これは実際に起こる。Dart は未処理の非同期
    // エラーをゾーンへ報告するだけだが、Node はプロセスを落とし、ブラウザは
    // `unhandledrejection` を上げる。同じコードの形が処理系で違う結末になる箇所。
    const boardDests = [...boardStops, goal];
    const [boardRows, alightRows] = await Promise.all([
      this.api.fetchWalkMatrix([origin], boardDests),
      alightStops.length === 0
        ? Promise.resolve<unknown[] | null>(null)
        : this.api.fetchWalkMatrix(alightStops, [goal]),
    ]);
    if (boardRows !== null) {
      for (const e of boardRows) {
        if (!isRecord(e)) continue;
        const di = intOr(e['destinationIndex'], 0);
        const min = parseDurationMin(e['duration']);
        if (min === null || di < 0 || di >= boardDests.length) continue;
        measured.set(walkCacheKey(origin, boardDests[di]), min);
      }
    }
    if (alightRows !== null) {
      for (const e of alightRows) {
        if (!isRecord(e)) continue;
        const oi = intOr(e['originIndex'], 0);
        const min = parseDurationMin(e['duration']);
        if (min === null || oi < 0 || oi >= alightStops.length) continue;
        measured.set(walkCacheKey(alightStops[oi], goal), min);
      }
    }
  }

  /// [base] のコリドーからフロンティアを絞り、アクセス徒歩を一括実測してハイブリッド候補を
  /// 作る（途中乗降＝徒歩最大化の主経路）。[measured] は呼び出し間で共有し、全徒歩
  /// (origin→goal) のレッグもここで測る。
  private async buildCorridorHybrids(
    base: TransitOption,
    origin: GeoPoint,
    goal: GeoPoint,
    budgetMin: number,
    departureAt: Date,
    measured: Map<string, number>,
  ): Promise<RouteCandidate[]> {
    const stops = this.corridorStops(base);
    const frontier = frontierStations(
      stops.map((s) => s.coord),
      origin,
      goal,
      budgetMin,
      { maxPerSide: maxMatrixSideStations },
    );
    const baseMin = base.segments.reduce((a, s) => a + s.minutes, 0);
    this.diag.log(
      () =>
        `base route: totalMin=${baseMin}m corridorStops=${stops.length} ` +
        `frontier.boarding=[${frontier.boarding.join(', ')}] ` +
        `alighting=[${frontier.alighting.join(', ')}]`,
    );
    await this.measureAccessWalks(
      origin,
      goal,
      frontier.boarding.map((i) => stops[i].coord),
      frontier.alighting.map((i) => stops[i].coord),
      measured,
    );
    this.diag.log(
      () =>
        `measured ${measured.size} legs; ` +
        `allWalk(origin->goal)=${measured.get(walkCacheKey(origin, goal))}m ` +
        '(null=matrix失敗→直線推定へ)',
    );
    const hybrids = this.buildMeasuredHybrids(
      base,
      stops,
      frontier,
      measured,
      origin,
      goal,
    );
    this.diag.log(() => `built ${hybrids.length} hybrids:`);
    for (const c of hybrids) {
      this.diag.log(
        () => `  hybrid: ${this.diag.candLine(c, budgetMin, departureAt)}`,
      );
    }
    return hybrids;
  }

  /// フロンティアの乗車駅 b → 降車駅 a（同一コリドー・b より後方）の分割を、実測アクセス
  /// 徒歩で候補化する。コリドー座標は時刻を持たないため乗車時間は折れ線長から距離概算
  /// （#67 と同じ untimed 経路）、運賃は取得不可のため null（§2.2-3）。
  private buildMeasuredHybrids(
    base: TransitOption,
    stops: CorridorStop[],
    frontier: FrontierStations,
    measured: Map<string, number>,
    origin: GeoPoint,
    goal: GeoPoint,
  ): RouteCandidate[] {
    const result: RouteCandidate[] = [];
    for (const b of frontier.boarding) {
      const walk1 = this.measuredWalkSeg(
        origin,
        stops[b].coord,
        base.from,
        stops[b].name,
        measured,
      );
      for (const a of frontier.alighting) {
        if (a <= b) continue;
        // 乗換をまたぐ b→a は単一乗車として表現できないため同一コリドーのみ。
        if (stops[a].section !== stops[b].section) continue;
        const rideKm = railKm(stops, b, a);
        // バス corridor でも [trainMetersPerMinute] のまま概算する（#251）。見積りは楽観側に
        // 倒すのが選定の不変条件（§6）——実速度で厳しく見積もると実ダイヤなら間に合うバスを
        // 選定段階で捨ててしまい回収できない。乗車時間は採用前に実時刻で上書きされる。
        const ride = dartRound((rideKm * 1000) / trainMetersPerMinute);
        if (ride < 0) continue;
        const walk2 = this.measuredWalkSeg(
          stops[a].coord,
          goal,
          stops[a].name,
          base.to,
          measured,
        );
        result.push(
          new RouteCandidate({
            from: base.from,
            to: base.to,
            segments: [
              ...(walk1.minutes > 0 ? [walk1] : []),
              new RouteSegment({
                type: stops[b].type,
                fromName: stops[b].name,
                toName: stops[a].name,
                minutes: ride,
                km: rideKm,
                line: stops[b].line,
                stops: a - b,
                polyline: stops.slice(b, a + 1).map((s) => s.coord),
              }),
              ...(walk2.minutes > 0 ? [walk2] : []),
            ],
          }),
        );
      }
    }
    return result;
  }

  /// 徒歩区間 [a]→[b] を実測分（[measured] にあれば）で、無ければ直線推定で作る。
  private measuredWalkSeg(
    a: GeoPoint,
    b: GeoPoint,
    fromName: string,
    toName: string,
    measured: Map<string, number>,
  ): RouteSegment {
    const est = this.estimateWalk(a, b, fromName, toName).segments[0];
    const min = measured.get(walkCacheKey(a, b));
    if (min === undefined || est.minutes === 0) return est;
    return new RouteSegment({
      type: SegmentType.walk,
      fromName,
      toName,
      minutes: min,
      km: est.km,
      kcal: est.kcal,
      polyline: est.polyline,
    });
  }

  /// 全徒歩候補を実測分（無ければ直線推定）で作る。
  private measuredWalk(
    origin: GeoPoint,
    goal: GeoPoint,
    fromName: string,
    toName: string,
    measured: Map<string, number>,
  ): RouteCandidate {
    return new RouteCandidate({
      from: fromName,
      to: toName,
      segments: [this.measuredWalkSeg(origin, goal, fromName, toName, measured)],
    });
  }

  /// 確定経路の徒歩区間を Google Routes の街路ジオメトリ・所要・距離で上書きする。
  /// 取得失敗時は元（guidance の polyline / 直線）を保つ。
  private async enrichWalkGeometry(
    chosen: RouteCandidate,
    cache: WalkLegCache,
  ): Promise<RouteCandidate> {
    // 徒歩区間の実測は互いに独立なので並列に投げる（#163）。
    const segments = await Promise.all(
      chosen.segments.map(async (seg) => {
        if (seg.type !== SegmentType.walk || seg.polyline.length < 2) return seg;
        const walk = await this.tryWalk(
          seg.polyline[0],
          seg.polyline[seg.polyline.length - 1],
          seg.fromName,
          seg.toName,
          cache,
        );
        return walk?.segments[0] ?? seg;
      }),
    );
    return new RouteCandidate({ from: chosen.from, to: chosen.to, segments });
  }

  private build(
    chosen: RouteCandidate,
    departure: TimeValue,
    budgetMin: number,
    onProgress: ((phase: RoutePhase) => void) | undefined,
    names: { fromName: string | null; toName: string | null },
  ): RoutePlan {
    onProgress?.(RoutePhase.building);
    const departureAt = this.departureDateTime(departure);
    return buildRoutePlan({
      from: displayName(names.fromName, chosen.from),
      to: displayName(names.toName, chosen.to),
      segments: chosen.segments,
      departure,
      budgetMin,
      departureAt,
    });
  }

  /// 徒歩最大化の基準に据えるバス corridor（#251）。**勝者自身が乗っているバス便**の
  /// option を返す。バスが勝っていないときは null で、#249 の train-only ガードが効き続ける。
  ///
  /// 最短のバス option を選んではいけない。選定の目的関数は「徒歩最大」なのに
  /// [baseForHybrid] の基準は「総所要最小」なので両者は食い違う。勝者と別の corridor を
  /// 基準にすると、乗車バス停探索が勝者と無関係な停留所を引き直して空振りする。
  private busBaseFor(
    winner: RouteCandidate,
    busCandidates: RouteCandidate[] | null,
    busOptions: TransitOption[] | null,
  ): TransitOption | null {
    if (busOptions === null) return null;
    if (!winner.segments.some((s) => s.type === SegmentType.bus)) return null;
    const i = busCandidates?.findIndex((c) => c === winner) ?? -1;
    const scope = i >= 0 ? [busOptions[i]] : busOptions;
    return this.baseForHybrid(scope, true);
  }

  /// コリドー（停車駅／線路点・バス停）を持つ最短の標準経路をハイブリッド・乗車駅探索の
  /// 基準にする。既定ではバス混在 option を基準にしない（#249）。[allowBus] を立てるのは
  /// last-resort 再照会で得たバス option を基準にするときだけ（#251）。
  private baseForHybrid(
    options: TransitOption[],
    allowBus = false,
  ): TransitOption | null {
    let best: TransitOption | null = null;
    let bestMin = 0;
    for (const o of options) {
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      if (!allowBus && o.segments.some((s) => s.type === SegmentType.bus)) {
        continue;
      }
      const min = o.segments.reduce((a, s) => a + s.minutes, 0);
      if (best === null || min < bestMin) {
        best = o;
        bestMin = min;
      }
    }
    return best;
  }

  /// ハイブリッドの土台に据える「路線ファミリの異なる代表 base」群（#292）。baseline の
  /// option 群を routeName 集合（[routeFamilyKey]）でフィンガープリントしてファミリごとに
  /// まとめ、各ファミリの代表を最大 [maxHybridBases] 本返す。**増分 API コストはゼロ**。
  ///
  /// ファミリ間の順序は総所要昇順、**同所要は代表 option の出現順**をタイブレークにする
  /// ——これを入れないと同所要のファミリで bases[0] が [baseForHybrid]（出現順で最初の最短を
  /// 採る）と食い違い、崩壊時 board-search の基準コリドーが #292 前と変わってしまう。
  /// タイブレークはファミリの初出位置ではなく**代表（最短）option の位置**で行う。
  basesForHybrid(options: TransitOption[]): TransitOption[] {
    const repByFamily = new Map<string, TransitOption>();
    const minByFamily = new Map<string, number>();
    const repIndexByFamily = new Map<string, number>();
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      if (o.segments.some((s) => s.type === SegmentType.bus)) continue;
      const key = this.routeFamilyKey(o);
      const min = o.segments.reduce((a, s) => a + s.minutes, 0);
      const current = minByFamily.get(key);
      if (current === undefined || min < current) {
        repByFamily.set(key, o);
        minByFamily.set(key, min);
        repIndexByFamily.set(key, i);
      }
    }
    const families = [...repByFamily.keys()].sort((a, b) => {
      const byMin = minByFamily.get(a)! - minByFamily.get(b)!;
      return byMin !== 0
        ? byMin
        : repIndexByFamily.get(a)! - repIndexByFamily.get(b)!;
    });
    return families.slice(0, maxHybridBases).map((k) => repByFamily.get(k)!);
  }

  /// option を路線ファミリへ要約するフィンガープリント（#292）。transit 区間の路線名の集合
  /// （順不同・重複除去・ソート）で表す。
  ///
  /// 路線名を欠く leg はコリドー形状で代替する。空だと全部が同じキーへ畳まれて別コリドーが
  /// 同一ファミリ扱いになり、多様化が静かに単一 base へ退行する。null も空文字も等しく
  /// 「無名」とみなす。端点だけだと同一 OD の急行・各停を区別できないため、polyline を
  /// 均等サンプルした座標列で表す。
  private routeFamilyKey(o: TransitOption): string {
    const keys = new Set<string>();
    for (const s of o.segments) {
      if (s.type !== SegmentType.train && s.type !== SegmentType.bus) continue;
      keys.add(
        s.line === null || s.line.length === 0
          ? `@${this.corridorFingerprint(s.polyline)}`
          : s.line,
      );
    }
    return [...keys].sort().join('|');
  }

  /// 路線名を欠くコリドーのフィンガープリント。
  private corridorFingerprint(polyline: GeoPoint[]): string {
    return evenSample(polyline, corridorFingerprintSamples)
      .map((p) => coordKey(p))
      .join(',');
  }

  /// ハイブリッド候補を構造フィンガープリントへ要約し、複数 base 由来の同一候補をマージ時に
  /// 重複除去する（#292）。乗降駅名は生成時点では空のことがあるため、区間の種別・路線名と
  /// polyline 端点（5桁丸め）で表す。
  private hybridKey(c: RouteCandidate): string {
    return c.segments
      .map(
        (s) =>
          `${s.type}:${s.line ?? ''}:` +
          `${coordKey(s.polyline.length > 0 ? s.polyline[0] : null)}>` +
          `${coordKey(s.polyline.length > 0 ? s.polyline[s.polyline.length - 1] : null)}`,
      )
      .join('|');
  }

  /// 波をまたぐ option の重複除去キー（#376）。落とすのは**同一便**だけで、構造
  /// （[hybridKey]）に**時刻表の同一性**（transit 区間の実発着時刻）を足して表す。
  ///
  /// **構造だけで畳んではいけない。** 到着アンカー第2波の主産物は「同じ系統の、締切ぎりぎり
  /// まで遅らせた便」＝路線名も乗降駅も departure 波と同じで時刻だけが違う便なので、構造だけの
  /// 鍵はこの波の中身をまるごと消す。
  ///
  /// **ハイブリッドの [hybridKey] は構造のままでよい。** あちらの時刻はコリドー由来で生成時
  /// には存在せず、時刻を混ぜても全部が「時刻なし」で並ぶだけになる。
  private optionKey(o: TransitOption): string {
    const parts = [
      this.hybridKey(
        new RouteCandidate({ from: o.from, to: o.to, segments: o.segments }),
      ),
    ];
    for (const s of o.segments) {
      if (s.type === SegmentType.walk) continue;
      parts.push(`${isoOrEmpty(s.depTime)}>${isoOrEmpty(s.arrTime)}`);
    }
    return parts.join('#');
  }

  /// base ごとのハイブリッド群（[perBase]）を [maxHybridCandidates] 本までマージ重複除去する
  /// （#292）。[within]（見積り到着が予算内か）が true の候補を**先に**上限まで詰め、余枠に
  /// のみ予算外を足す。予算外の徒歩多め候補が上限を食い潰し、予算内の短めハイブリッドを
  /// 締め出して標準乗換/全徒歩へ縮退させる退行を防ぐ。各フェーズ内は base 間ラウンドロビン
  /// （各 base は徒歩多い順）で、1ファミリの候補群が他ファミリを締め出さないようにする。
  mergeHybrids(
    perBase: RouteCandidate[][],
    within: (candidate: RouteCandidate) => boolean,
  ): RouteCandidate[] {
    const sorted = perBase.map((list) =>
      [...list].sort((a, b) => b.walkMinutes - a.walkMinutes),
    );
    const seen = new Set<string>();
    const out: RouteCandidate[] = [];
    for (const keepWithin of [true, false]) {
      const phase = sorted.map((list) =>
        list.filter((h) => within(h) === keepWithin),
      );
      for (let rank = 0; out.length < maxHybridCandidates; rank++) {
        let progressed = false;
        for (const list of phase) {
          if (rank >= list.length) continue;
          progressed = true;
          const key = this.hybridKey(list[rank]);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(list[rank]);
          }
          if (out.length >= maxHybridCandidates) break;
        }
        if (!progressed) break;
      }
      if (out.length >= maxHybridCandidates) break;
    }
    return out;
  }

  /// [base] の全コリドー座標を origin→goal 方向に連結し、乗車駅候補（[CorridorStop]）へ
  /// 変換する。gtfsShape は頂点が密なため均等間引きで [maxCorridorStops] 以下へ絞る（§2.3）。
  /// section は transit leg（電車・バス問わず）番号、line/type は対応するセグメントの
  /// 路線名・種別。`TransitCorridor.legIndex` は全 transit leg の通し番号のため、対応する
  /// セグメント列も train に絞らず transit 全体で揃える（#249）。
  private corridorStops(base: TransitOption): CorridorStop[] {
    const transitSegs = base.segments.filter(
      (s) => s.type === SegmentType.train || s.type === SegmentType.bus,
    );
    const out: CorridorStop[] = [];
    for (const c of base.corridors) {
      const seg = c.legIndex < transitSegs.length ? transitSegs[c.legIndex] : null;
      for (const p of evenSample(c.coords, maxCorridorStops)) {
        out.push(
          new CorridorStop(p, c.legIndex, seg?.line ?? null, seg?.type ?? SegmentType.train),
        );
      }
    }
    return out;
  }

  // ---- Transit API（[TransitApiClient] 経由の引き直し） ----

  /// [at] 発として**到着を信じて比べられる** option だけへ絞る。皆無なら [options] を
  /// そのまま返す（先頭1本）。
  ///
  /// 到着で比べる前に必ず通す。[arrivalMinutes] は時刻の穴・不整合を**待ち0や負の所要**
  /// として黙って進めるため、壊れた便ほど速く見える。条件は2つ：
  ///
  /// - **各区間の所要が前へ進むこと。** transit は発着が揃い到着が発車以降であること
  ///   ——片側欠落は所要 0 分＝乗った瞬間に着く便になり、到着＜発車は所要が負になって
  ///   [arrivalMinutes] の累積を**手前へ戻す**。乗換徒歩も同じ。なお**所要0分の徒歩は
  ///   弾かない**——数十秒の乗換は正当に0分へ丸まる。
  /// - **[at] 発で行程が成立すること**（[firstMissedTransit] が立たない）。乗れない便は
  ///   待ちが 0 へ丸められて「待ち無しで乗れる速い便」に見える。**下流が捨てる便を先に
  ///   選ぶと、捨てた時点で代わりはもう無い**。
  ///
  /// 判定に [hasUnverifiedTransit] を使わないのは、あれが「その便が走っているか」だけを
  /// 問う（depTime のみ見る）から。**必要なのは実在の確認ではなく、到着を計算できることの確認。**
  private comparableFrom(options: TransitOption[], at: Date): TransitOption[] {
    const comparable = options.filter(
      (o) =>
        o.segments.every(hasUsableTimes) &&
        firstMissedTransit(o.segments, at) === null,
    );
    if (comparable.length > 0) return comparable;
    // 1本も無いときは**先頭だけ**返す（従来の挙動）。全部返して呼び出し側に選ばせると、
    // 到着を信じられないと判定した便をその到着で順位付けすることになり、負の所要で到着が
    // 手前へ戻る便が勝つ——「必ず現状以上」（#343）の保証が破れる。
    return options.length === 0 ? options : [options[0]];
  }

  /// 引き直しの応答から、[at] 発で**到着が最も早い** option を選ぶ（同着は上流の並び順）。
  /// 該当が無ければ null。
  ///
  /// 素直には応答の先頭を採りたいが、`numItineraries` 本の並びは所要順である保証が無く、
  /// 実測では乗り換えを失って降車後166分歩く経路が先頭に来た（#343）。判定と同じ尺度
  /// （[arrivalMinutes]）で選べば、採る候補は必ず先頭採用時と同じか良い。
  private earliestArrival(
    options: TransitOption[],
    at: Date,
  ): TransitOption | null {
    let best: TransitOption | null = null;
    let bestArr = 0;
    for (const o of this.comparableFrom(options, at)) {
      const arr = arrivalMinutes(o.segments, at);
      if (best === null || arr < bestArr) {
        best = o;
        bestArr = arr;
      }
    }
    return best;
  }

  /// 乗車駅候補 X から goal への経路を引き直し、transit 区間を含む option を**全部**返す
  /// （実時刻を確認できた便を優先し、その中は上流の並び順）。全徒歩しか返らない・上流が
  /// 失敗したときは空。
  ///
  /// 1本に畳まずに返すのは、探索が option へ二つの別々の問いを投げるため（#343 レビュー）：
  /// 「この地点は予算内か」は到着最早で決まるが、プールへ渡す候補は**予算内の中で徒歩最大**
  /// でなければならない。
  private async fetchTransitOptionsFrom(
    x: GeoPoint,
    goal: GeoPoint,
    at: Date,
    options: { allowBus?: boolean; onUpstreamFailure?: () => void } = {},
  ): Promise<TransitOption[]> {
    let body: JsonMap;
    try {
      body = await this.api.fetchGuidanceAt(x, goal, at, {
        allowBus: options.allowBus ?? false,
      });
    } catch (error) {
      if (!(error instanceof RouteException)) throw error;
      // 上流の失敗（429・5xx・TIMEOUT）と「引けたが transit 区間が無い」を、呼び出し側は
      // どちらも空として同じに扱う。ただし前者は**この地点が予算外だった**ことを意味しない。
      options.onUpstreamFailure?.();
      return [];
    }
    return this.comparableFrom(
      parseGuidancePlan(body).filter((o) =>
        o.segments.some((s) => s.type !== SegmentType.walk),
      ),
      at,
    );
  }

  // ---- Google Routes（徒歩実測をドメイン候補へ変換） ----

  /// origin→dest の徒歩を Google Routes(WALK, プロキシ経由)で取得して徒歩区間候補にする。
  /// レッグ単位キャッシュ（座標5桁丸めキー）。失敗時は null。
  private async tryWalk(
    origin: GeoPoint,
    dest: GeoPoint,
    fromName: string,
    toName: string,
    cache: WalkLegCache | null,
  ): Promise<RouteCandidate | null> {
    // キャッシュのレッグ実測は区間名に依らずキー（座標丸め）で共有し、呼び出し側の
    // fromName/toName は取得後に被せる。同一レッグを複数候補が同時に測る候補間並列
    // （#315）では、resolve が in-flight の Promise も単一化して二重発行を防ぐ。
    const key = walkCacheKey(origin, dest);
    const result =
      cache === null
        ? await this.fetchWalkLeg(origin, dest)
        : await cache.resolve(key, () => this.fetchWalkLeg(origin, dest));
    return result === null ? null : renameWalk(result, fromName, toName);
  }

  /// origin→dest の徒歩を Google 実測で1レッグ分取得する。区間名はキャッシュ共有のため
  /// 素の空名で組み、呼び出し側が被せる。上流失敗（[RouteException]）は null へ縮退するが、
  /// [SearchCanceledException] は別型なのでそのまま伝播する。
  private async fetchWalkLeg(
    origin: GeoPoint,
    dest: GeoPoint,
  ): Promise<RouteCandidate | null> {
    try {
      const body = await this.api.fetchWalkRoute(origin, dest);
      const routes = body['routes'];
      if (!Array.isArray(routes) || routes.length === 0) return null;
      const route = routes[0];
      if (!isRecord(route)) return null;
      const minutes = parseDurationMin(route['duration']);
      if (minutes === null) return null;
      const km = intOr(route['distanceMeters'], 0) / 1000.0;
      const shape = parseEncodedPolyline(route['polyline']);
      return new RouteCandidate({
        from: '',
        to: '',
        segments: [
          new RouteSegment({
            type: SegmentType.walk,
            fromName: '',
            toName: '',
            minutes,
            km,
            kcal: dartRound(km * kcalPerKm),
            polyline: shape.length > 0 ? shape : [origin, dest],
          }),
        ],
      });
    } catch (error) {
      if (!(error instanceof RouteException)) throw error;
      return null;
    }
  }

  /// origin→dest を直線距離から推定した徒歩区間候補にする（API 呼び出しなし）。
  private estimateWalk(
    origin: GeoPoint,
    dest: GeoPoint,
    fromName: string,
    toName: string,
  ): RouteCandidate {
    const km = haversineKm(origin, dest);
    const minutes = dartRound((km * 1000) / walkMetersPerMinute);
    return new RouteCandidate({
      from: fromName,
      to: toName,
      segments: [
        new RouteSegment({
          type: SegmentType.walk,
          fromName,
          toName,
          minutes,
          km,
          kcal: dartRound(km * kcalPerKm),
          polyline: [origin, dest],
        }),
      ],
    });
  }

  /// 出発の絶対時刻。dateOffset（isNow→0）で日付を決定する。
  ///
  /// 日送りは経過時間の加算ではなく `day` フィールドへの加算で行う。経過時間の加算は
  /// DST 端末で日跨ぎの壁時計を1時間ずらす（spring-forward を跨ぐと翌日以降指定の発車が
  /// 1時間ずれる）。フィールド加算なら暦で正規化される——#121・#376 と同じクラス。
  private departureDateTime(t: TimeValue): Date {
    const now = this.clock();
    return dateTime(
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate() + effectiveOffset(t),
      t.h,
      t.m,
    );
  }
}

/// 乗車駅探索・ハイブリッドの候補点。コリドー座標（停車駅 or 線路点）から作る。
/// 時刻・運賃は持たない（Transit API では取得不可・§2.2-3）。
class CorridorStop {
  constructor(
    readonly coord: GeoPoint,
    /// 属する transit leg（電車・バス問わず）番号。乗換をまたぐ点は番号が異なる。
    readonly section: number,
    readonly line: string | null,
    /// この点が属する区間種別（電車 or バス）。通常照会では train のみ。last-resort の
    /// バス候補を基準に据えたときだけ bus になる（#251）。
    readonly type: SegmentType,
  ) {}

  /// ハイブリッド駅名は不明（コリドー座標に駅名は付かない）。空表示。
  get name(): string {
    return '';
  }
}

/// 徒歩レッグ実測の1検索分キャッシュ。完了結果に加えて **in-flight の Promise** も
/// レッグキーで共有する。#315 で予算内候補を候補**間**並列で一括実測するようになり、
/// 同一 egress レッグを持つ候補が同時に enrich されるが、完了結果しか持たない素の Map では
/// 両者ともキャッシュを外して `googleWalkProxy` を二重発行する。
class WalkLegCache {
  private readonly done = new Map<string, RouteCandidate>();
  private readonly inflight = new Map<string, Promise<RouteCandidate | null>>();

  /// [key] の実測を単一化する。完了済みなら即返し、実行中なら同じ Promise に相乗り、
  /// どちらも無ければ [fetch] を1回だけ起こす。失敗（null 解決や例外）は永続キャッシュ
  /// しない——一過性のプロキシ失敗を検索の残り全体へ固定しないため。
  resolve(
    key: string,
    fetch: () => Promise<RouteCandidate | null>,
  ): Promise<RouteCandidate | null> {
    const done = this.done.get(key);
    if (done !== undefined) return Promise.resolve(done);
    // 相乗り者・起動者が全員この1本を await するよう、in-flight は単一の Promise に統一する。
    // 後始末を別 Promise へ枝分かれさせると、fetch がエラーで倒れたとき誰も await しない枝が
    // 未処理例外になる（catch 済みでもテストが落ちる）。try/finally ならエラーは唯一の
    // Promise に載ってすべての await 側で処理される。
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;
    const started = this.resolveUncached(key, fetch);
    this.inflight.set(key, started);
    return started;
  }

  private async resolveUncached(
    key: string,
    fetch: () => Promise<RouteCandidate | null>,
  ): Promise<RouteCandidate | null> {
    try {
      const result = await fetch();
      if (result !== null) this.done.set(key, result);
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }
}

/// 出発〜到着の予算（分）。[budgetMinutes] を直接使わず薄く包むのは、このファイルが
/// `budgetMin` という名前の局所変数を多用するため。
function budgetMinutesOf(departure: TimeValue, arrival: TimeValue): number {
  return (
    arrival.totalMinutes +
    effectiveOffset(arrival) * 24 * 60 -
    (departure.totalMinutes + effectiveOffset(departure) * 24 * 60)
  );
}

/// enrich／実時刻検証を経た区間列が確定不変条件（#254）に反しているかの3条件判定。
/// (a) 予算超過、(b) 乗り遅れ、(c) 実発車時刻を確認できない transit 区間を含む
/// （#137 幻便／#250 幽霊バス）。確定経路の検証基準の単一実装。
function invariantViolation(
  segments: RouteSegment[],
  budgetMin: number,
  departureAt: Date,
): { overBudget: boolean; missed: boolean; unverified: boolean } {
  return {
    overBudget: arrivalMinutes(segments, departureAt) > budgetMin,
    missed: firstMissedTransit(segments, departureAt) !== null,
    unverified: hasUnverifiedTransit(segments),
  };
}

/// 予算内候補が無いときの縮退先（#121）。「今夜乗れる」範囲の実到着最早を返す。
function bestEffort(
  candidates: RouteCandidate[],
  budgetMin: number,
  departureAt: Date,
): RouteCandidate {
  const pool =
    reachableWithinBudget(candidates, budgetMin, departureAt) ?? candidates;
  return pool.reduce((a, b) =>
    arrivalMinutes(a.segments, departureAt) <=
    arrivalMinutes(b.segments, departureAt)
      ? a
      : b,
  );
}

function renameWalk(
  cached: RouteCandidate,
  fromName: string,
  toName: string,
): RouteCandidate {
  return new RouteCandidate({
    from: fromName,
    to: toName,
    segments: [cached.segments[0].copyWith({ fromName, toName })],
  });
}

function displayName(override: string | null, fallback: string): string {
  const name = override?.trim();
  return name !== undefined && name.length > 0 ? name : fallback;
}

/// コリドー区間 [b]→[a]（同一 section・連続インデックス）の折れ線長（km）。
function railKm(stops: CorridorStop[], b: number, a: number): number {
  let km = 0;
  for (let i = b; i < a; i++) {
    km += haversineKm(stops[i].coord, stops[i + 1].coord);
  }
  return km;
}

function hasUsableTimes(s: RouteSegment): boolean {
  if (s.type === SegmentType.walk) return s.minutes >= 0;
  const dep = s.depTime;
  const arr = s.arrTime;
  return dep !== null && arr !== null && arr.getTime() >= dep.getTime();
}

/// option の [type] 区間のうち最初の1本。呼び出し側は事前に「[type] が1本だけ」を
/// 確かめている（[TransitRouteService.fetchTransitEndpoints]）。
function firstOfType(o: TransitOption, type: SegmentType): RouteSegment {
  const leg = o.segments.find((s) => s.type === type);
  if (leg === undefined) {
    throw new Error(`no ${type} segment in option`);
  }
  return leg;
}

function coordKey(p: GeoPoint | null): string {
  return p === null ? '-' : `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

function walkCacheKey(origin: GeoPoint, dest: GeoPoint): string {
  return (
    `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}` +
    `|${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`
  );
}

/// Dart の `DateTime.toIso8601String()` に相当する位置。UTC の `Z` 付きになる点は
/// 移植元と違うが、用途は同一検索内での**便の同一性**の判定だけで、どちらも時刻に対して
/// 単射なので畳み方は変わらない。
function isoOrEmpty(d: Date | null): string {
  return d === null ? '' : d.toISOString();
}

function parseDurationMin(duration: unknown): number | null {
  if (typeof duration !== 'string') return null;
  const digits = duration.replaceAll('s', '');
  if (!/^[+-]?\d+$/.test(digits)) return null;
  return dartRound(Number.parseInt(digits, 10) / 60);
}

function parseEncodedPolyline(polyline: unknown): GeoPoint[] {
  const encoded = isRecord(polyline) ? polyline['encodedPolyline'] : null;
  if (typeof encoded !== 'string' || encoded.length === 0) return [];
  return decodePolyline(encoded).map(([lat, lng]) => new GeoPoint(lat, lng));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/// Dart の `(x as num?)?.toInt() ?? fallback`。
function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? Math.trunc(value) : fallback;
}

/// 出発絶対時刻に経過分を足す。移植元の `departureAt.add(Duration(minutes: n))` に対応する
/// ——ここは**経過時間**の加算で正しい（`n` は行程を進んだ実所要分であって暦の量ではない）。
function plusMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60000);
}

/// Dart の `Future.ignore()` に対応する。拒否を捨てる**別の** Promise を作るだけなので、
/// 後から元を await する経路の例外伝播は妨げない——キャンセルを握り潰さないために必要な性質。
function ignore(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

/// Dart の `future.timeout(d)` に対応する。[limit] 内に解決しなければ [TimeoutException]。
function withGrace<T>(promise: Promise<T>, limit: Duration): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutException(`grace exceeded after ${limit}ms`)),
      limit,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
