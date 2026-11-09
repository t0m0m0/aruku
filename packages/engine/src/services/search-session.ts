import { ignore } from '../promises';
import { startedStopwatch } from '../stopwatch';
import { RouteCandidate } from './hybrid-route-selector';
import { BestEffortLedger, EnrichLatencyLedger } from './route-diagnostics';
import type { TransitOption } from './transit-plan-parser';

/// 検索1回ぶんの共有状態（#486）。検索ごとに作り、検索をまたいで使い回さない——
/// キャッシュを検索間で共有すると、別の出発時刻で測った実時刻や失敗が次の検索へ漏れる。
export class SearchSession {
  /// 徒歩レッグの実測。in-flight の照会にも相乗りする。
  readonly walkCache = new WalkLegCache();

  /// 候補の実測（enrich 徒歩＋実発車時刻解決）を identity で畳むキャッシュ（#315）。
  /// [RouteCandidate] は値等価を持たないので同一インスタンス単位で畳む。
  readonly enrichedCache = new Map<RouteCandidate, RouteCandidate>();

  /// アクセス徒歩の一括実測（マトリクス）の結果。レッグキー → 分（#485）。
  readonly accessWalks = new Map<string, number>();

  /// enrich の臨界パスを「パス本数」と「1候補の直列段数」に分けて計上する（#318）。
  readonly enrichLedger = new EnrichLatencyLedger();

  /// 縮退は測定口を通らないので別台帳。実測では enrichMs の9割がここだった。
  readonly bestEffortLedger = new BestEffortLedger();

  readonly provenance = new CandidateProvenance();
}

/// 候補の出自。候補にも option にも出自欄は無く、足すと選定の純粋関数群まで型が波及する
/// ので、生成箇所でインスタンスの同一性を控える。**候補をコピーすると出自が切れる**
/// ——best-effort 縮退は実時刻を当てたコピーを作るので、その勝者は出自を引けない。
export class CandidateProvenance {
  /// 到着アンカー第2波（#376）由来。
  readonly arrivalWave = new Set<RouteCandidate>();

  /// コリドー実測由来のハイブリッド。予算内にこれが多いほど reject 多発＝先行実測を
  /// 短リスト全体へ広げる（Option A・#318）。
  readonly hybrids = new Set<RouteCandidate>();

  /// 厳密走査（#460）の1回乗車の候補。
  readonly exact = new Set<RouteCandidate>();

  /// 厳密走査の乗換つきの候補（#474）。
  readonly transfer = new Set<RouteCandidate>();

  /// board-search 由来の候補 → 生まれたラウンド。電車系・バス系で共有する。
  readonly boardSearchRound = new Map<RouteCandidate, number>();
}

/// last-resort のバス再照会（#250）。照会は高々1回で、**採用**するのは予算内候補が出ない
/// ときだけ。
///
/// 照会の発行（[prefetch]）と採用（[adopt]）を分けてあるのは、照会自体は best-effort の
/// 実測結果に依存しないから。直列に置くと上流1本ぶんの段が丸ごと体感へ乗る（実機 12.6s）。
///
/// **発行しただけでは [options] を埋めない。** 崩壊判定の比較集合と `busBaseFor` は
/// [options] の非 null を「バスが土俵に乗ったか」の判定に使う。投機で埋めると、バスが
/// 勝っていない検索でも比較集合が膨らんで崩壊が不成立になり、board-search が静かに抑制
/// され得る（＝徒歩最大化の劣化）。
export class LastResortBus {
  constructor(
    private readonly fetch: () => Promise<TransitOption[]>,
    /// 投機で覆えなかった残りの直列待ち（発行から完了までの全体ではない）の受け口。
    private readonly onWaited: (ms: number) => void,
  ) {}

  private pending: Promise<TransitOption[]> | null = null;
  private adoptedOptions: TransitOption[] | null = null;
  private adoptedCandidates: RouteCandidate[] | null = null;

  /// 採用したバスの option。採用していなければ null。
  get options(): TransitOption[] | null {
    return this.adoptedOptions;
  }

  /// 採用したバスの候補。採用していなければ null。
  get candidates(): RouteCandidate[] | null {
    return this.adoptedCandidates;
  }

  prefetch(): void {
    if (this.adoptedCandidates !== null || this.pending !== null) return;
    this.pending = this.fetch();
    // 採用しない経路で未処理例外にしないための番人。
    ignore(this.pending);
  }

  async adopt(): Promise<RouteCandidate[]> {
    if (this.adoptedCandidates !== null) return this.adoptedCandidates;
    this.prefetch();
    const waitSw = startedStopwatch();
    this.adoptedOptions = await this.pending!;
    this.onWaited(waitSw.elapsedMilliseconds);
    this.adoptedCandidates = this.adoptedOptions.map(
      (o) => new RouteCandidate({ from: o.from, to: o.to, segments: o.segments }),
    );
    return this.adoptedCandidates;
  }
}

/// 徒歩レッグ実測の1検索分キャッシュ。完了結果に加えて **in-flight の Promise** も
/// レッグキーで共有する。#315 で予算内候補を候補**間**並列で一括実測するようになり、
/// 同一 egress レッグを持つ候補が同時に enrich されるが、完了結果しか持たない素の Map では
/// 両者ともキャッシュを外して `googleWalkProxy` を二重発行する。
export class WalkLegCache {
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
