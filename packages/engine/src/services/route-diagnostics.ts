// 移植元: lib/core/services/route_diagnostics.dart

import { kDebugMode, kReleaseMode } from '../build-mode';
import { notImplemented } from '../not-implemented';
import type { RouteCandidate } from './hybrid-route-selector';

/// 乗車駅探索**1本**分の計上。1検索に2本立つことがある——電車系（base）とバス系
/// （busBase）は基準コリドーが独立で、並行して走る（#304）。
export class BoardSearchStats {
  /// この探索が回したラウンド数。
  rounds = 0;

  /// この探索が走査した index 数。
  scanCount = 0;

  /// この探索が実際に打ち上げた probe 本数（上流失敗ぶんも含む）。
  probes = 0;

  /// この探索が**評価済みの中で予算内だった最遠 index**（皆無なら -1）。
  best = -1;

  /// 締切で**新しいラウンドを起こさずに打ち切った**か（#300）。
  truncated = false;

  /// **入力が劣化したまま評価された probe があったか**（上流の 429・5xx・タイムアウト）。
  probeFailed = false;

  /// **ラウンドを1つ終えるごとの「評価済みで予算内だった最大徒歩（見積り・分）」**。
  readonly walkByRound: number[] = [];

  /// この探索がプローブ内で払った直列の壁時計と、その直列を解いた下限。
  readonly probeLatency = new ProbeLatencyLedger();
}

/// 乗車駅探索のプローブ内で払っている**直列**の壁時計と、それを並列化したときの下限を
/// 同一 run から両方計上する台帳。
export class ProbeLatencyLedger {
  /// プローブ1本の内訳を現在のラウンドへ記録する。
  record(args: { walkMs: number; guidanceMs: number }): void {
    notImplemented(`ProbeLatencyLedger.record(${args.walkMs})`);
  }

  /// 現在のラウンドを締めて累積へ畳む。
  endRound(): void {
    notImplemented('ProbeLatencyLedger.endRound');
  }

  /// 現状の壁時計（Σ_rounds 最遅プローブの walk+guidance）。
  get serialMs(): number {
    return notImplemented('ProbeLatencyLedger.serialMs');
  }

  /// プローブ内の直列を解いたときの壁時計の下限（Σ_rounds 最遅プローブの max(walk, guidance)）。
  get parallelMs(): number {
    return notImplemented('ProbeLatencyLedger.parallelMs');
  }
}

/// enrich フェーズの臨界パスを「パスの本数」と「1候補の直列段数」に分けて計上する台帳。
export class EnrichLatencyLedger {
  /// 実測した候補数（キャッシュヒットを除く）＝上流ファンアウトの幅。
  candidates = 0;

  /// 1候補が `_resolveBoardingTimes` で直列に積んだ guidance の最大段数。
  resolveDepth = 0;

  /// 候補1件の実測を現在のパスへ記録する。
  record(args: {
    chainMs: number;
    walkMs: number;
    resolveSteps: number;
  }): void {
    notImplemented(`EnrichLatencyLedger.record(${args.chainMs})`);
  }

  /// 現在のパスを締めて累積へ畳む。
  endPass(): void {
    notImplemented('EnrichLatencyLedger.endPass');
  }

  /// 直列に積んだパスの壁時計の合計（Σ_passes 最遅候補）。
  get criticalPathMs(): number {
    return notImplemented('EnrichLatencyLedger.criticalPathMs');
  }

  /// [criticalPathMs] のうち徒歩 enrich が占めた壁時計（Σ_passes 最遅候補の徒歩）。
  get walkPathMs(): number {
    return notImplemented('EnrichLatencyLedger.walkPathMs');
  }

  /// 直列に走ったパスの本数。
  get passes(): number {
    return notImplemented('EnrichLatencyLedger.passes');
  }
}

/// best-effort 縮退（`_bestEffortResolved`）の費用を計上する台帳。
export class BestEffortLedger {
  /// `_bestEffortResolved` に入った回数。
  entries = 0;

  /// 実時刻解決したのべ候補数＝短リスト上限に縛られないファンアウト幅。
  candidates = 0;

  /// プール解決で1候補が直列に積んだ引き直しの最大段数。
  resolveDepth = 0;

  /// 再試行ループが回った回数（＝直列に積んだ徒歩 enrich の追加段数）。
  retries = 0;

  /// 縮退に費やした実時間の合計。
  totalMs = 0;

  enter(): void {
    notImplemented('BestEffortLedger.enter');
  }

  recordPool(args: { candidates: number; resolveDepth: number }): void {
    notImplemented(`BestEffortLedger.recordPool(${args.candidates})`);
  }

  recordRetry(): void {
    notImplemented('BestEffortLedger.recordRetry');
  }

  addMs(ms: number): void {
    notImplemented(`BestEffortLedger.addMs(${ms})`);
  }
}

/// 到着アンカー第2波（#376）の結末。`arrivalWaveOutcome=<index>` として1行ログに出す。
///
/// 他の enum（`SegmentType`）と違い**数値**を値にしている。1行ログのコード（0〜3）は
/// 集計器（tool/route_metrics_agg.dart）が読む契約そのもので、テストがその値を固定して
/// いるため——文字列にすると `index` に相当するものが消え、写像を別に持つことになる。
export const ArrivalWaveOutcome = {
  /// 解析可能な非空応答。
  ok: 0,

  /// departure 波の確定後、猶予（`_arrivalWaveGrace`）内に返らなかった。
  timeout: 1,

  /// HTTP 失敗・パース不能。
  error: 2,

  /// 応答は返ったが option が0本。
  empty: 3,
} as const;
export type ArrivalWaveOutcome =
  (typeof ArrivalWaveOutcome)[keyof typeof ArrivalWaveOutcome];

/// 1検索分の定量指標（#309）。
export class RouteSearchMetrics {
  /// 崩壊判定（`_isCollapse`）が true になったか（board-search を試みる契機）。
  collapseFired = false;

  /// board-search フォールバックが実際に候補を引きに走ったか。
  boardSearchActivated = false;

  /// 非崩壊ルートの先行実測で予算内短リスト全体を1パスで温めたか（Option A・#318）。
  singlePassMeasure = false;

  /// 初回 `/guidance/plan` の **departure 波**（必須の1本）に掛かった実時間（ミリ秒）。
  guidanceMs = 0;

  /// ハイブリッド候補生成（コリドー実測マトリクス＋候補構築）区間の実時間。
  hybridMs = 0;

  /// 選定＋enrich（実測徒歩・実発車時刻の確定検証）区間の実時間。
  enrichMs = 0;

  /// board-search フォールバック区間の実時間（起動しなければ 0）。
  boardSearchMs = 0;

  /// **最も深い1本の**乗車駅探索が回したラウンド数。
  boardSearchRounds = 0;

  /// 乗車駅探索が実際に走査した index 数（`walkFeasiblePrefixCount` で刈った後）。
  boardSearchScanCount = 0;

  /// 乗車駅探索で**評価済みのうち予算内だった最遠 index**。未探索・予算内皆無は -1。
  boardSearchBest = -1;

  /// [boardSearchBest] を出した探索が締切で打ち切られたか（#300）。
  boardSearchTruncated = false;

  /// [boardSearchBest] を出した探索に、入力が劣化したまま評価された probe があったか。
  boardSearchProbeFailed = false;

  /// 報告する探索の、ラウンドごとの「予算内の最大徒歩（見積り・分）」の推移。
  boardSearchWalkByRound: readonly number[] = [];

  /// **確定候補が board-search の何ラウンド目の probe 由来か。**
  /// -1 未起動 / 0 由来でない・特定不能 / N≥1 そのラウンドの probe。
  boardSearchWinnerRound = -1;

  /// 確定経路の徒歩（分）。未確定は -1。
  finalWalkMinutes = -1;

  /// 報告する探索がプローブ内で払った直列の壁時計。
  boardSearchProbeSerialMs = 0;

  /// 同じ探索で、プローブ内の直列を解いたときの壁時計の下限。
  boardSearchProbeParallelMs = 0;

  /// 電車系 board-search を `preCollapse` の見込みで enrich と**並行に**起動したか（#341）。
  boardSearchSpeculated = false;

  /// 投機起動したが `collapse` が偽で結果を捨てたか（＝無駄撃ち）。
  boardSearchSpeculationWasted = false;

  /// 空振りした投機が上流へ打ち上げた probe 本数。
  boardSearchSpeculationProbes = 0;

  /// enrich の臨界パス（Σ_passes 最遅候補）。
  enrichCriticalMs = 0;

  /// [enrichCriticalMs] のうち徒歩 enrich（Google 徒歩ルート）が占めた壁時計。
  enrichWalkMs = 0;

  /// enrich が直列に走らせたパスの本数。
  enrichPasses = 0;

  /// 1候補が `_resolveBoardingTimes` で直列に積んだ guidance の最大段数。
  enrichResolveDepth = 0;

  /// 実測した候補数（キャッシュヒットを除く）＝上流ファンアウトの幅。
  enrichCandidates = 0;

  /// best-effort 縮退に費やした実時間。
  bestEffortMs = 0;

  /// 縮退へ入った回数。
  bestEffortEntries = 0;

  /// 縮退が実時刻解決したのべ候補数。
  bestEffortCandidates = 0;

  /// 縮退のプール解決で1候補が直列に積んだ引き直しの最大段数。
  bestEffortResolveDepth = 0;

  /// 縮退の再試行ループが回った回数。
  bestEffortRetries = 0;

  /// バス last-resort 再照会で**なお直列に待った**時間。
  busLastResortMs = 0;

  /// 確定候補の駅名確定（`_finalizeStationNames`）に掛かった実時間。
  finalizeMs = 0;

  /// `plan` 入口〜確定までの全体実時間。
  totalMs = 0;

  /// `/guidance/plan` の実 HTTP 往復本数（初回＋引き直し）。
  guidanceCalls = 0;

  /// [guidanceCalls] のうち同一リクエストの重複発行だった本数。
  guidanceDupCalls = 0;

  /// 到着アンカー第2波（#376）の結末。null は第2波を await する前＝未確定で、
  /// 1行ログには -1 で出す。
  arrivalWaveOutcome: ArrivalWaveOutcome | null = null;

  /// 第2波から候補プールへ**純増**した option 数（構造フィンガープリント dedup の後）。
  arrivalWaveOptions = 0;

  /// `basesForHybrid` が選んだ base に第2波由来の option が含まれたか。
  arrivalWaveBaseUsed = false;

  /// 確定候補が第2波由来か。
  arrivalWaveWon = false;

  /// Google 徒歩ルート（enrich）の実 HTTP 往復本数。
  walkCalls = 0;

  /// Google 徒歩マトリクスの実 HTTP 往復本数。
  matrixCalls = 0;

  /// 1検索あたりの上流 HTTP 往復本数の実測（全種別の合計）。
  get httpRoundTrips(): number {
    return notImplemented('RouteSearchMetrics.httpRoundTrips');
  }

  /// 空振りした投機の対価を計上する（#341）。
  recordSpeculationWaste(stats: BoardSearchStats): void {
    notImplemented(`RouteSearchMetrics.recordSpeculationWaste(${stats.probes})`);
  }

  /// 並列に走った乗車駅探索群（[BoardSearchStats]）を1検索ぶんの指標へ畳む。
  recordBoardSearches(searches: readonly BoardSearchStats[]): void {
    notImplemented(`RouteSearchMetrics.recordBoardSearches(${searches.length})`);
  }

  /// 並列に走った enrich 台帳を1検索ぶんの指標へ畳む。
  recordEnrich(ledger: EnrichLatencyLedger): void {
    notImplemented(`RouteSearchMetrics.recordEnrich(${ledger.candidates})`);
  }

  /// best-effort 台帳を1検索ぶんの指標へ畳む。
  recordBestEffort(ledger: BestEffortLedger): void {
    notImplemented(`RouteSearchMetrics.recordBestEffort(${ledger.entries})`);
  }

  /// grep で機械集計できる安定した key=value 1行に整形する。
  toLogLine(): string {
    return notImplemented('RouteSearchMetrics.toLogLine');
  }
}

export interface RouteDiagnosticsInit {
  verbose?: boolean;
  metricsEnabled?: boolean;
}

/// 経路選定（[TransitRouteService]）の診断ログ整形を担う。
export class RouteDiagnostics {
  constructor(init: RouteDiagnosticsInit = {}) {
    this.verbose = init.verbose ?? kDebugMode;
    this.metricsEnabled = init.metricsEnabled ?? !kReleaseMode;
  }

  private readonly verbose: boolean;
  private readonly metricsEnabled: boolean;

  /// 選定ログ1行を `[route]` プレフィックス付きで出す（verbose が真のときのみ）。
  log(build: () => string): void {
    notImplemented(`RouteDiagnostics.log(${String(this.verbose)})`);
  }

  /// 1検索分の定量指標（#309）を `[route-metrics]` プレフィックス付きで1行出す。
  logMetrics(metrics: RouteSearchMetrics): void {
    notImplemented(
      `RouteDiagnostics.logMetrics(${String(this.metricsEnabled)})`,
    );
  }

  /// 候補の区間構成を `walk12m+蒲12_train33m+walk3m` 形式の短い文字列にする（ログ用）。
  segSummary(c: RouteCandidate): string {
    return notImplemented(`RouteDiagnostics.segSummary(${c.from})`);
  }

  /// 候補1件の診断行（ログ用）。
  candLine(c: RouteCandidate, budgetMin: number, departureAt: Date): string {
    return notImplemented(`RouteDiagnostics.candLine(${budgetMin})`);
  }

  /// 候補の最初のtransit（電車・バス）区間の乗車駅名（ログ用）。
  boardingStationOf(c: RouteCandidate): string {
    return notImplemented(`RouteDiagnostics.boardingStationOf(${c.from})`);
  }
}
