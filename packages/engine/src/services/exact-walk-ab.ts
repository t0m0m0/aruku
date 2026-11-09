import { startedStopwatch, type Stopwatch } from '../stopwatch';
import type { CandidateMeasurer, Selection } from './candidate-measurer';
import type { RouteCandidate } from './hybrid-route-selector';
import type { RouteDiagnostics, RouteSearchMetrics } from './route-diagnostics';
import type { CandidateProvenance, WalkLegCache } from './search-session';
import type { TransitApiClient } from './transit-api-client';

/// 厳密走査の効果を同じ実行の中で比べる A/B/B' 計測（#462・#474・§3.9）の、A が確定した
/// 後の工程。通常の検索（A）の進行とは独立に読めるよう、[TransitRouteService] から分けた（#486）。
export interface ExactWalkAbInput {
  /// A の確定（厳密走査の候補を混ぜずに最後まで走らせた結果）。
  a: Selection;
  /// A の最終候補プール。バス・board-search の候補を含み、厳密走査の候補は含まない。
  poolA: RouteCandidate[];
  /// A が崩壊したか。
  collapseA: boolean;
  /// 厳密走査の応答を候補にして受け取る。**B の直前で初めて待つ**——A の間に待つと、
  /// A が使わない応答の待ちが「厳密走査なし」の A の所要へ乗る。
  takeExact: () => Promise<RouteCandidate[]>;
  /// A と同じ比較集合での崩壊判定。
  isCollapse: (chosen: RouteCandidate) => boolean;
  /// A と同じキャッシュで、台帳だけ分けて選び直す。同じ台帳に積むと enrich の内訳が
  /// A の実測でなくなる。
  reselect: (from: RouteCandidate[], rejected?: Set<RouteCandidate>) => Promise<Selection>;
  provenance: CandidateProvenance;
  walkCache: WalkLegCache;
  metrics: RouteSearchMetrics;
  budgetMin: number;
  departureAt: Date;
}

/// A の後に B・B' を選び直し、返すべき確定（B'）と、B 以降の所要を測る時計を返す。
/// 時計は呼び出し側が確定経路の駅名復元まで含めて止める（`abMs`）。
export async function runExactWalkAb(
  deps: { measurer: CandidateMeasurer; api: TransitApiClient; diag: RouteDiagnostics },
  x: ExactWalkAbInput,
): Promise<{ selected: Selection; abSw: Stopwatch }> {
  const { measurer, api, diag } = deps;
  const { metrics, provenance } = x;
  // B（#462）。A の最終候補プールに厳密走査の候補を足して選び直す。A が投げた要求は
  // 上流へ投げ直さず A の結末（失敗を含む）を使う＝差は厳密走査の候補だけから来る。
  metrics.walkA = x.a.enriched.walkMinutes;
  // A の駅名復元も A の工程として先に済ませる。B の勝者だけを復元すると、A の所要
  // （totalMs − abMs）からこの往復が抜け、代わりに B の復元が入る。結果は使わない。
  const finalizeASw = startedStopwatch();
  await measurer.finalizeStationNames(x.a.enriched, x.departureAt);
  metrics.finalizeMs = finalizeASw.elapsedMilliseconds;
  const abSw = startedStopwatch();
  const heldExact = await x.takeExact();
  metrics.transferCandidates =
    metrics.exactCandidates < 0 ? -1 : provenance.transfer.size;
  api.startReplay();
  let selected = await x.reselect([...x.poolA, ...heldExact]);
  metrics.walkB = selected.enriched.walkMinutes;
  metrics.exactWon = provenance.exact.has(selected.chosen);
  // B の勝者が厳密走査の候補でなければ B は A と同じ経路なので、崩壊も A のまま。
  // 勝者で判定し直すと、A の board-search が解いた崩壊を厳密走査の手柄に数える。
  metrics.collapseB = provenance.exact.has(selected.chosen)
    ? x.isCollapse(selected.chosen)
    : x.collapseA;
  // B'（#474）。比べる相手は B の勝者と乗換つきの候補だけにする。全プールへ足さないのは、
  // 実測の上限（maxMeasureShortlist）で B の勝者が押し出され、乗換つきが全滅すると検証済みの
  // 勝者を失うため。B の勝者はプールの最良なので、他の候補は要らない。返すのは B'——
  // 乗換つきの候補の乗り遅れ・予算超過は、確定経路を返さないと結果の記録に残らない。
  metrics.walkBPrime = metrics.walkB;
  const transfers = provenance.transfer;
  const measurable = await measurer.withMeasuredTransferWalks([...transfers], x.walkCache);
  metrics.transferDropped = transfers.size - measurable.length;
  if (measurable.length > 0) {
    const rejected = new Set<RouteCandidate>();
    selected = await x.reselect([selected.chosen, ...measurable], rejected);
    metrics.walkBPrime = selected.enriched.walkMinutes;
    metrics.transferWon = transfers.has(selected.chosen);
    metrics.transferDropped += [...rejected].filter((c) => transfers.has(c)).length;
  }
  const finalSelected = selected;
  diag.log(
    () =>
      `A/B: walkA=${metrics.walkA}m walkB=${metrics.walkB}m ` +
      `walkBPrime=${metrics.walkBPrime}m ` +
      `B'=${diag.candLine(finalSelected.enriched, x.budgetMin, x.departureAt)}`,
  );
  return { selected, abSw };
}
