// 移植元: lib/core/services/route_diagnostics.dart

import { kDebugMode, kReleaseMode } from '../build-mode';
import { debugPrint } from '../debug-print';
import { SegmentType } from '../models/route-plan';
import type { RouteCandidate } from './hybrid-route-selector';
import {
  arrivalMinutes,
  firstMissedTransit,
  maxBoardingWait,
} from './route-plan-builder';

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
  private closedSerial = 0;
  private closedParallel = 0;
  private roundSerial = 0;
  private roundParallel = 0;

  /// プローブ1本の内訳を現在のラウンドへ記録する。徒歩がレッグキャッシュにヒットした
  /// プローブは [walkMs] が 0 近傍になり、そのぶん自動的に削減可能量から外れる。
  ///
  /// [walkMs] には徒歩レッグキャッシュの in-flight に相乗りして他プローブの取得を待った
  /// 時間も含める。待たされた実壁時計こそがユーザーの体感で、除くと削減可能量を過小に
  /// 見積もる。
  record(args: { walkMs: number; guidanceMs: number }): void {
    const serial = args.walkMs + args.guidanceMs;
    const parallel = Math.max(args.walkMs, args.guidanceMs);
    if (serial > this.roundSerial) this.roundSerial = serial;
    if (parallel > this.roundParallel) this.roundParallel = parallel;
  }

  /// 現在のラウンドを締めて累積へ畳む。プローブが無いラウンドは 0 の加算＝実質 no-op
  /// （`onRound` はラウンド**開始時**に呼ばれるので、1本目の締めは必ず空になる）。
  endRound(): void {
    this.closedSerial += this.roundSerial;
    this.closedParallel += this.roundParallel;
    this.roundSerial = 0;
    this.roundParallel = 0;
  }

  /// 現状の壁時計（Σ_rounds 最遅プローブの walk+guidance）。
  get serialMs(): number {
    return this.closedSerial + this.roundSerial;
  }

  /// プローブ内の直列を解いたときの壁時計の下限（Σ_rounds 最遅プローブの max(walk, guidance)）。
  get parallelMs(): number {
    return this.closedParallel + this.roundParallel;
  }

  // 進行中ラウンドをゲッタ側で足すのは、末尾フラッシュを呼び出し側の義務にしないため。
  // 探索は締切超過（shouldContinue）で while を break で抜けるので、「最後に endRound を
  // 呼ぶ」規約は最も測りたいケース（打ち切られるほど重かった探索）で静かに破れる。
}

/// enrich フェーズの臨界パスを「パスの本数」と「1候補の直列段数」に分けて計上する台帳。
export class EnrichLatencyLedger {
  private closedCritical = 0;
  private passCritical = 0;
  private closedWalk = 0;
  private passWalk = 0;
  private closedPasses = 0;
  private passHasCandidate = false;

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
    this.candidates++;
    this.passHasCandidate = true;
    if (args.chainMs > this.passCritical) {
      this.passCritical = args.chainMs;
      this.passWalk = args.walkMs;
    }
    if (args.resolveSteps > this.resolveDepth) {
      this.resolveDepth = args.resolveSteps;
    }
  }

  /// 現在のパスを締めて累積へ畳む。候補が1件も無いパスは本数に数えない——先行実測が
  /// 発火しない検索では空の締めが先に来るため。
  endPass(): void {
    if (!this.passHasCandidate) return;
    this.closedCritical += this.passCritical;
    this.closedWalk += this.passWalk;
    this.closedPasses++;
    this.passCritical = 0;
    this.passWalk = 0;
    this.passHasCandidate = false;
  }

  /// 直列に積んだパスの壁時計の合計（Σ_passes 最遅候補）。
  get criticalPathMs(): number {
    return this.closedCritical + (this.passHasCandidate ? this.passCritical : 0);
  }

  /// [criticalPathMs] のうち徒歩 enrich が占めた壁時計（Σ_passes 最遅候補の徒歩）。
  /// 差 `criticalPathMs − walkPathMs` が引き直しの実時間。
  get walkPathMs(): number {
    return this.closedWalk + (this.passHasCandidate ? this.passWalk : 0);
  }

  /// 直列に走ったパスの本数。
  get passes(): number {
    return this.closedPasses + (this.passHasCandidate ? 1 : 0);
  }

  // 進行中パスをゲッタ側で足すのは [ProbeLatencyLedger] と同じ理由——勝者が見つかった
  // 時点で tier ループを抜けるため、末尾の締めを呼び出し側の義務にすると
  // 「1パスで決まった」最も一般的なケースがまるごと 0 になる。
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
    this.entries++;
  }

  recordPool(args: { candidates: number; resolveDepth: number }): void {
    this.candidates += args.candidates;
    if (args.resolveDepth > this.resolveDepth) {
      this.resolveDepth = args.resolveDepth;
    }
  }

  recordRetry(): void {
    this.retries++;
  }

  addMs(ms: number): void {
    this.totalMs += ms;
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
    return this.guidanceCalls + this.walkCalls + this.matrixCalls;
  }

  /// 空振りした投機の対価を計上する（#341）。発火（[boardSearchSpeculated]）と対で読む。
  recordSpeculationWaste(stats: BoardSearchStats): void {
    this.boardSearchSpeculationWasted = true;
    this.boardSearchSpeculationProbes = stats.probes;
  }

  /// 並列に走った乗車駅探索群（[BoardSearchStats]）を1検索ぶんの指標へ畳む。
  ///
  /// [boardSearchRounds] は**和ではなく最大**——2系統は並列に走る（#304）ので、和にすると
  /// 「1本の探索が何段積んだか」という意味が壊れ、アルゴリズムの比較に使えなくなる。
  /// 最大を採るのは、報告する他のフィールドと同じ**支配探索1本**を指すため。
  ///
  /// [boardSearchScanCount]・[boardSearchBest]・[boardSearchTruncated]・
  /// [boardSearchProbeFailed]・[boardSearchProbeSerialMs]・[boardSearchProbeParallelMs]
  /// は**同一の探索から採る**（対を崩すと `best/scanCount` が実在しない比になり、truncated が
  /// 別の探索を指すと有効なサンプルを捨てる）。採るのは段数を決めた探索＝報告する
  /// [boardSearchRounds] と整合する1本。同点なら走査範囲の広い方。
  recordBoardSearches(searches: readonly BoardSearchStats[]): void {
    let dominant: BoardSearchStats | null = null;
    for (const s of searches) {
      if (s.rounds > this.boardSearchRounds) this.boardSearchRounds = s.rounds;
      if (
        dominant === null ||
        s.rounds > dominant.rounds ||
        (s.rounds === dominant.rounds && s.scanCount > dominant.scanCount)
      ) {
        dominant = s;
      }
    }
    if (dominant === null) return;
    this.boardSearchScanCount = dominant.scanCount;
    this.boardSearchBest = dominant.best;
    this.boardSearchTruncated = dominant.truncated;
    this.boardSearchProbeFailed = dominant.probeFailed;
    // serial/parallel は**必ず対で**同じ台帳から採る。別探索から拾うと差＝削減可能量が
    // 実在しない値になり、打つ価値の判定を誤らせる。
    this.boardSearchWalkByRound = Object.freeze([...dominant.walkByRound]);
    this.boardSearchProbeSerialMs = dominant.probeLatency.serialMs;
    this.boardSearchProbeParallelMs = dominant.probeLatency.parallelMs;
  }

  /// 並列に走った enrich 台帳を1検索ぶんの指標へ畳む。board-search
  /// （[recordBoardSearches]）と違い**台帳は検索に1つ**なので、支配探索を選ぶ必要がない。
  recordEnrich(ledger: EnrichLatencyLedger): void {
    this.enrichCriticalMs = ledger.criticalPathMs;
    this.enrichWalkMs = ledger.walkPathMs;
    this.enrichPasses = ledger.passes;
    this.enrichResolveDepth = ledger.resolveDepth;
    this.enrichCandidates = ledger.candidates;
  }

  /// best-effort 台帳を1検索ぶんの指標へ畳む。
  recordBestEffort(ledger: BestEffortLedger): void {
    this.bestEffortMs = ledger.totalMs;
    this.bestEffortEntries = ledger.entries;
    this.bestEffortCandidates = ledger.candidates;
    this.bestEffortResolveDepth = ledger.resolveDepth;
    this.bestEffortRetries = ledger.retries;
  }

  /// grep で機械集計できる安定した key=value 1行に整形する。bool は割合を出しやすいよう
  /// 0/1 に落とす（`grep 'collapse=1' | wc -l` で発火数、総数で割れば発火率）。
  toLogLine(): string {
    return (
      `collapse=${flag(this.collapseFired)} ` +
      `boardSearch=${flag(this.boardSearchActivated)} ` +
      `singlePass=${flag(this.singlePassMeasure)} ` +
      `http=${this.httpRoundTrips} ` +
      `guidanceCalls=${this.guidanceCalls} walkCalls=${this.walkCalls} matrixCalls=${this.matrixCalls} ` +
      `guidanceDupCalls=${this.guidanceDupCalls} ` +
      `arrivalWaveOutcome=${this.arrivalWaveOutcome ?? -1} ` +
      `arrivalWaveOptions=${this.arrivalWaveOptions} ` +
      `arrivalWaveBaseUsed=${flag(this.arrivalWaveBaseUsed)} ` +
      `arrivalWaveWon=${flag(this.arrivalWaveWon)} ` +
      `guidanceMs=${this.guidanceMs} hybridMs=${this.hybridMs} enrichMs=${this.enrichMs} ` +
      `boardSearchMs=${this.boardSearchMs} ` +
      `boardSearchRounds=${this.boardSearchRounds} ` +
      `boardSearchScanCount=${this.boardSearchScanCount} ` +
      `boardSearchBest=${this.boardSearchBest} ` +
      `boardSearchTruncated=${flag(this.boardSearchTruncated)} ` +
      `boardSearchProbeFailed=${flag(this.boardSearchProbeFailed)} ` +
      `boardSearchProbeSerialMs=${this.boardSearchProbeSerialMs} ` +
      `boardSearchProbeParallelMs=${this.boardSearchProbeParallelMs} ` +
      `boardSearchSpeculated=${flag(this.boardSearchSpeculated)} ` +
      `boardSearchSpeculationWasted=${flag(this.boardSearchSpeculationWasted)} ` +
      `boardSearchSpeculationProbes=${this.boardSearchSpeculationProbes} ` +
      `enrichCriticalMs=${this.enrichCriticalMs} enrichWalkMs=${this.enrichWalkMs} ` +
      `enrichPasses=${this.enrichPasses} ` +
      `enrichResolveDepth=${this.enrichResolveDepth} ` +
      `enrichCandidates=${this.enrichCandidates} ` +
      `bestEffortMs=${this.bestEffortMs} bestEffortEntries=${this.bestEffortEntries} ` +
      `bestEffortCandidates=${this.bestEffortCandidates} ` +
      `bestEffortResolveDepth=${this.bestEffortResolveDepth} ` +
      `bestEffortRetries=${this.bestEffortRetries} ` +
      `busLastResortMs=${this.busLastResortMs} ` +
      'boardSearchWalkByRound=' +
      `${this.boardSearchWalkByRound.length === 0 ? '-' : this.boardSearchWalkByRound.join(',')} ` +
      `boardSearchWinnerRound=${this.boardSearchWinnerRound} ` +
      `finalWalkMinutes=${this.finalWalkMinutes} ` +
      `finalizeMs=${this.finalizeMs} totalMs=${this.totalMs}`
    );
  }
}

/// bool を 1 行ログの 0/1 へ落とす。
const flag = (value: boolean): string => (value ? '1' : '0');

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
  ///
  /// メッセージは遅延ビルダで受け取る。verbose が偽のリリースビルドではクロージャを
  /// 評価せず、高コストな文字列構築を一切行わない（#164）。引数を先に評価する
  /// `log(message: string)` では、ガードが効く前にコストを払っていた。
  log(build: () => string): void {
    if (this.verbose) debugPrint(`[route] ${build()}`);
  }

  /// 1検索分の定量指標（#309）を `[route-metrics]` プレフィックス付きで1行出す
  /// （metricsEnabled が真のとき＝既定では release 以外）。定性ログ（[log]）と別
  /// プレフィックス・別フラグにして、profile ビルドの実機ログからも発火率・本数を
  /// `grep '\[route-metrics\]'` で切り出して集計できるようにする（debug 限定にすると
  /// フィールド計測で使う profile で一切出ない・#309 レビュー指摘）。
  logMetrics(metrics: RouteSearchMetrics): void {
    if (this.metricsEnabled) {
      debugPrint(`[route-metrics] ${metrics.toLogLine()}`);
    }
  }

  /// 候補の区間構成を `walk12m+蒲12_train33m+walk3m` 形式の短い文字列にする（ログ用）。
  segSummary(c: RouteCandidate): string {
    return c.segments
      .map((s) => {
        switch (s.type) {
          case SegmentType.walk:
            return `walk${s.minutes}m`;
          case SegmentType.train:
            return `${s.line ?? 'train'}_train${s.minutes}m`;
          case SegmentType.bus:
            return `${s.line ?? 'bus'}_bus${s.minutes}m`;
        }
      })
      .join('+');
  }

  /// 候補1件の診断行（ログ用）。徒歩分・実到着・余り・予算内可否・最大乗車待ち・
  /// 乗り遅れの有無・区間構成を1行に詰める。「徒歩最大が崩壊して短い乗車＋大余りが
  /// 残る」過程（#137）を候補単位で追える。
  candLine(c: RouteCandidate, budgetMin: number, departureAt: Date): string {
    const arr = arrivalMinutes(c.segments, departureAt);
    const missed = firstMissedTransit(c.segments, departureAt);
    const wait = maxBoardingWait(c.segments, departureAt);
    return (
      `walk=${c.walkMinutes}m arr=${arr}m slack=${budgetMin - arr}m ` +
      `within=${arr <= budgetMin} maxWait=${wait}m ` +
      `missed=${missed !== null} [${this.segSummary(c)}]`
    );
  }

  /// 候補の最初のtransit（電車・バス）区間の乗車駅名（ログ用）。乗車駅探索でコリドー上の
  /// どの点が実際にどの駅から乗ることになるかを見て、間引きで乗れる駅を飛ばしていないかを
  /// 切り分ける（#137 診断）。transit区間が無い・駅名空なら '?'。
  boardingStationOf(c: RouteCandidate): string {
    for (const s of c.segments) {
      switch (s.type) {
        case SegmentType.walk:
          continue;
        case SegmentType.train:
        case SegmentType.bus:
          return s.fromName.length === 0 ? '?' : s.fromName;
      }
    }
    return '?';
  }
}
