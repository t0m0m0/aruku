import { startedStopwatch, type Stopwatch } from '../stopwatch';
import type { CandidateMeasurer, Selection } from './candidate-measurer';
import type { RouteCandidate } from './hybrid-route-selector';
import type { RouteDiagnostics, RouteSearchMetrics } from './route-diagnostics';
import type { CandidateProvenance, WalkLegCache } from './search-session';
import type { TransitApiClient } from './transit-api-client';

export interface ExactWalkAbInput {
  a: Selection;
  poolA: RouteCandidate[];
  collapseA: boolean;
  takeExact: () => Promise<RouteCandidate[]>;
  isCollapse: (chosen: RouteCandidate) => boolean;
  reselect: (from: RouteCandidate[], rejected?: Set<RouteCandidate>) => Promise<Selection>;
  provenance: CandidateProvenance;
  walkCache: WalkLegCache;
  metrics: RouteSearchMetrics;
  budgetMin: number;
  departureAt: Date;
}

export async function runExactWalkAb(
  deps: { measurer: CandidateMeasurer; api: TransitApiClient; diag: RouteDiagnostics },
  x: ExactWalkAbInput,
): Promise<{ selected: Selection; abSw: Stopwatch }> {
  const { measurer, api, diag } = deps;
  const { metrics, provenance } = x;
  metrics.walkA = x.a.enriched.walkMinutes;
  const finalizeASw = startedStopwatch();
  await measurer.finalizeStationNames(x.a.enriched, x.departureAt);
  metrics.finalizeMs = finalizeASw.elapsedMilliseconds;
  const abSw = startedStopwatch();
  const heldExact = await x.takeExact();
  metrics.transferCandidates = metrics.exactCandidates < 0 ? -1 : provenance.transfer.size;
  api.startReplay();
  let selected = await x.reselect([...x.poolA, ...heldExact]);
  metrics.walkB = selected.enriched.walkMinutes;
  metrics.exactWon = provenance.exact.has(selected.chosen);
  metrics.collapseB = provenance.exact.has(selected.chosen)
    ? x.isCollapse(selected.chosen)
    : x.collapseA;
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
