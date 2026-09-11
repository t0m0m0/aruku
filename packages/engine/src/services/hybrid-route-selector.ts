// 移植元: lib/core/services/hybrid_route_selector.dart

import { dartRound } from '../dart-number';
import type { GeoPoint } from '../models/geo-point';
import { SegmentType, type RouteSegment } from '../models/route-plan';
import {
  arrivalMinutes,
  firstMissedTransit,
  maxBoardingWait,
  walkMetersPerMinute,
} from './route-plan-builder';

export interface RouteCandidateInit {
  from: string;
  to: string;
  segments: RouteSegment[];
}

/// 経路候補（全徒歩・ハイブリッド・標準乗換のいずれか）。データ源に依存しない。
export class RouteCandidate {
  constructor(init: RouteCandidateInit) {
    this.from = init.from;
    this.to = init.to;
    this.segments = init.segments;
  }

  readonly from: string;
  readonly to: string;
  readonly segments: RouteSegment[];

  get totalMin(): number {
    return this.segments.reduce((a, s) => a + s.minutes, 0);
  }

  get walkMinutes(): number {
    return this.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);
  }

  get transferCount(): number {
    const transitSegmentCount = this.segments.filter(
      (s) => s.type !== SegmentType.walk,
    ).length;
    return transitSegmentCount === 0 ? 0 : transitSegmentCount - 1;
  }

  get totalKm(): number {
    return this.segments.reduce((a, s) => a + (s.km ?? 0), 0);
  }

  get walkKm(): number {
    return this.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + (s.km ?? 0), 0);
  }
}

export interface SelectBestRouteArgs {
  candidates: RouteCandidate[];
  budgetMin: number;
  origin?: GeoPoint | null;
  goal?: GeoPoint | null;
  departureAt?: Date | null;
  maxBacktrackRatio?: number;
}

/// 予算内で「徒歩時間最大」の候補を選ぶ。予算内が無ければ最短（ベストエフォート）。
///
/// [origin]/[goal] を渡すと、電車区間が出発地より進行方向の後方へ
/// [maxBacktrackRatio] × 直線距離(origin→goal) を超えて戻る「逆戻り迂回」候補を
/// 選定前に除外する。全候補が逆戻りなら除外せず最短へ縮退する。
///
/// [departureAt] を渡すと、予算内判定・タイブレーク・縮退のすべてで totalMin ではなく
/// 時刻表の待ちを含む実到着（[arrivalMinutes]）を用いる。
export function selectBestRoute(args: SelectBestRouteArgs): RouteCandidate {
  const { candidates, budgetMin } = args;
  const origin = args.origin ?? null;
  const goal = args.goal ?? null;
  const departureAt = args.departureAt ?? null;
  const maxBacktrackRatio = args.maxBacktrackRatio ?? defaultMaxBacktrackRatio;

  // Dart 版は `assert`（リリースで消える）で、空なら reduce が StateError で倒れる。
  // 消える検査に寄せず常に投げるのは、空プールが「選べる経路が無い」ではなく
  // **呼び出し側の組み立て漏れ**だから——縮退させると原因から遠い場所で壊れる。
  if (candidates.length === 0) {
    throw new Error('candidates must not be empty');
  }

  const pool = forwardCandidates(candidates, origin, goal, {
    maxBacktrackRatio,
  });

  // 待ち時間込みの実到着分。departureAt が無ければ待ち抜き合計へフォールバック。
  const arrival = (c: RouteCandidate): number =>
    departureAt === null ? c.totalMin : arrivalMinutes(c.segments, departureAt);

  const within = pool.filter((c) => arrival(c) <= budgetMin);
  if (within.length > 0) {
    return within.reduce((a, b) => {
      if (a.walkMinutes !== b.walkMinutes) {
        return a.walkMinutes > b.walkMinutes ? a : b;
      }
      const arrivalA = arrival(a);
      const arrivalB = arrival(b);
      if (arrivalA !== arrivalB) return arrivalA < arrivalB ? a : b;
      return a.transferCount <= b.transferCount ? a : b;
    });
  }
  // 予算内が無いとき（best-effort）。departureAt 指定時は、乗車待ちが予算を超える
  // 「今夜乗れない」電車（終電後の翌朝始発など）を後回しにし、乗車待ちが予算内の候補
  // （全徒歩は待ち0で常に含む）から最早到着を選ぶ（#121 原因②）。予算が十分大きく
  // 実際に待てる場合は電車も残るため、原理的に正しい挙動になる。
  const fallback =
    departureAt === null
      ? pool
      : (reachableWithinBudget(pool, budgetMin, departureAt) ?? pool);
  return fallback.reduce((a, b) => {
    const arrivalA = arrival(a);
    const arrivalB = arrival(b);
    if (arrivalA !== arrivalB) return arrivalA < arrivalB ? a : b;
    return a.transferCount <= b.transferCount ? a : b;
  });
}

/// 逆戻り迂回とみなす後退量の、直線距離(origin→goal)に対する比。
const defaultMaxBacktrackRatio = 0.15;

/// best-effort 選定で「今夜乗れる」候補に絞る。該当が無ければ null を返し、
/// 呼び出し側は元の全候補へ縮退する。
export function reachableWithinBudget(
  candidates: RouteCandidate[],
  budgetMin: number,
  departureAt: Date,
): RouteCandidate[] | null {
  const reachable = candidates.filter(
    (c) =>
      maxBoardingWait(c.segments, departureAt) <= budgetMin &&
      firstMissedTransit(c.segments, departureAt) === null,
  );
  return reachable.length === 0 ? null : reachable;
}

/// 出発地より進行方向の後方へ [maxBacktrackRatio] × 直線距離(origin→goal) を超えて戻る
/// 「逆戻り迂回」候補を除いた前方プールを返す。全候補が逆戻りならそのまま返す。
export function forwardCandidates(
  candidates: RouteCandidate[],
  origin: GeoPoint | null,
  goal: GeoPoint | null,
  options: { maxBacktrackRatio?: number } = {},
): RouteCandidate[] {
  if (origin === null || goal === null) return candidates;
  const maxBacktrackRatio =
    options.maxBacktrackRatio ?? defaultMaxBacktrackRatio;
  const forward = candidates.filter(
    (c) => !isBacktrackDetour(c, origin, goal, maxBacktrackRatio),
  );
  return forward.length > 0 ? forward : candidates;
}

/// 候補の transit 区間（電車・バス）に、出発地より進行方向(origin→goal)の後方へ
/// [maxBacktrackRatio] × 直線距離(origin→goal) を超えて戻る駅を含むか。
/// 徒歩区間は判定しない（目的地へ近づくための短い徒歩を弾かないため）。
///
/// 判定は電車区間 polyline を均等サンプリングした点で行い、生の全頂点は使わない
/// （[evenSample] を [maxBacktrackSamplesPerLeg] 点まで）。`stopOrder` の polyline は
/// 停車駅座標で疎（サンプリング上限以下）なので全点がそのまま使われる。一方 Transit API の
/// gtfsShape は線路追従で頂点が密（数百）なため、全頂点を判定すると乗車直後などの
/// 一過性の後方カーブ頂点1つで正当な経路を誤除外してしまう。サンプリングにより
/// コリドーの大局的な逆戻りのみを検出する（docs/spec/route-optimization.md §2.3）。
function isBacktrackDetour(
  c: RouteCandidate,
  origin: GeoPoint,
  goal: GeoPoint,
  maxBacktrackRatio: number,
): boolean {
  const dog = haversineKm(origin, goal);
  if (dog === 0) return false;
  const limit = -maxBacktrackRatio * dog;
  for (const seg of c.segments) {
    switch (seg.type) {
      case SegmentType.walk:
        continue;
      case SegmentType.train:
      case SegmentType.bus:
        for (const p of evenSample(seg.polyline, maxBacktrackSamplesPerLeg)) {
          if (advanceKm(origin, goal, dog, p) < limit) return true;
        }
    }
  }
  return false;
}

/// 逆戻り判定に使う電車区間 polyline のサンプリング上限。gtfsShape の密な頂点を
/// この数へ間引き、一過性の後方頂点による誤除外を防ぐ（[isBacktrackDetour]）。
const maxBacktrackSamplesPerLeg = 32;

/// 点 [p] の、origin→goal 方向への射影長（km）。前方なら正、出発地より後方
/// （目的地と逆方向）なら負。余弦定理で origin→p ベクトルを origin→goal 方向へ
/// 射影して求める。[dog] は origin→goal 距離（呼び出し側で算出済みを渡す）。
/// 球面距離を平面の余弦定理へ投入する近似だが、都市スケールでは十分。
function advanceKm(
  origin: GeoPoint,
  goal: GeoPoint,
  dog: number,
  p: GeoPoint,
): number {
  const dop = haversineKm(origin, p);
  const dpg = haversineKm(p, goal);
  return (dop * dop + dog * dog - dpg * dpg) / (2 * dog);
}

export interface MeasureShortlistArgs {
  candidates: RouteCandidate[];
  budgetMin: number;
  departureAt: Date;
  origin?: GeoPoint | null;
  goal?: GeoPoint | null;
}

/// 見積り予算内候補を実測する短リスト（#315/#318）。逆戻り除外の上で見積り実到着が
/// 予算内の候補だけを、徒歩降順→実到着昇順→乗換少ない順で返す（cap は掛けない）。
export function measureShortlist(
  args: MeasureShortlistArgs,
): RouteCandidate[] {
  const { candidates, budgetMin, departureAt } = args;
  const forward = forwardCandidates(
    candidates,
    args.origin ?? null,
    args.goal ?? null,
  );
  return forward
    .filter((c) => arrivalMinutes(c.segments, departureAt) <= budgetMin)
    .sort((a, b) => {
      if (a.walkMinutes !== b.walkMinutes) {
        return b.walkMinutes - a.walkMinutes;
      }
      const aa = arrivalMinutes(a.segments, departureAt);
      const ab = arrivalMinutes(b.segments, departureAt);
      if (aa !== ab) return aa - ab;
      return a.transferCount - b.transferCount;
    });
}

export interface PrewarmFrontArgs {
  shortlist: RouteCandidate[];
  chosen: RouteCandidate;
  hybrids: Set<RouteCandidate>;
  singlePassHybridThreshold: number;
  maxMeasureShortlist: number;
  allowSinglePass?: boolean;
}

export interface PrewarmFront {
  prewarm: RouteCandidate[];
  singlePass: boolean;
}

/// 非崩壊ルートで先行実測（キャッシュ温め・#315）する候補集合と single-pass 発火有無を返す。
export function prewarmFront(args: PrewarmFrontArgs): PrewarmFront {
  const { shortlist, chosen, hybrids } = args;
  const allowSinglePass = args.allowSinglePass ?? true;
  const inBudgetHybrids = shortlist.filter((c) => hybrids.has(c)).length;
  if (allowSinglePass && inBudgetHybrids >= args.singlePassHybridThreshold) {
    const cap = Math.min(shortlist.length, args.maxMeasureShortlist);
    return { prewarm: shortlist.slice(0, cap), singlePass: true };
  }
  return { prewarm: [chosen], singlePass: false };
}

export interface MaxWalkBoardingIndexArgs {
  count: number;
  budgetMin: number;
  evaluate: (index: number) => Promise<number>;
}

/// 乗車駅探索（docs/spec/route-optimization.md §3.6）：乗車駅候補について
/// 「到着が予算内の最遠 index ＝ 総徒歩最大」を二分探索で返す。
/// 先頭すら予算外・[count] が 0 なら null（[count] 0 では [evaluate] を一度も呼ばない）。
export async function maxWalkBoardingIndex(
  args: MaxWalkBoardingIndexArgs,
): Promise<number | null> {
  const { count, budgetMin, evaluate } = args;
  let lo = 0;
  let hi = count - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((await evaluate(mid)) <= budgetMin) {
      best = mid; // mid は予算内。さらに遠く（大きい index）を試す。
      lo = mid + 1;
    } else {
      hi = mid - 1; // mid は予算外。手前を試す。
    }
  }
  return best;
}

export interface MaxWalkBoardingIndexParallelArgs {
  count: number;
  budgetMin: number;

  /// null は「未評価」——到着が予算内かを判定できなかった（上流の 429・タイムアウト等）
  /// ことを表し、境界の更新に一切使わない（#333）。
  evaluate: (index: number) => Promise<number | null>;
  fanout?: number;
  shouldContinue?: () => boolean;
  onRound?: () => void;
}

/// [maxWalkBoardingIndex] のk分割並列版（#163）。ラウンド数は
/// O(log_{fanout+1} count)、壁時計は「ラウンド数 × 最遅1評価」になる。
///
/// 残り全 index が [fanout] 本以内に収まるラウンドは内点分割をやめ1ラウンドで評価する
/// （#332）。1ラウンドの同時発行は [fanout] 本を超えない。
/// ラウンドの probe が全て未評価なら探索を打ち切る。
export async function maxWalkBoardingIndexParallel(
  args: MaxWalkBoardingIndexParallelArgs,
): Promise<number | null> {
  const { count, budgetMin, evaluate } = args;
  const fanout = args.fanout ?? 3;
  let lo = 0;
  let hi = count - 1;
  let best: number | null = null;
  while (lo <= hi) {
    if (args.shouldContinue !== undefined && !args.shouldContinue()) break;
    args.onRound?.();
    // 区間 [lo, hi] を (fanout+1) 等分する内分点。区間が狭いと同一点へ縮退する
    // ため Set で重複除去する（probe は必ず区間内にあり、毎ラウンド区間が縮む）。
    const span = hi - lo;
    // 素直には全ラウンドを内点分割で揃えたいが、内点 `lo + span*j/(fanout+1)` は hi を
    // 含まないため、区間が狭くなっても末尾のためだけにもう1ラウンド（＝上流 guidance
    // 1本ぶんの壁時計）が残る。残り全 index が fanout 本以内に収まるなら1ラウンドで打つ。
    // 条件が `span <= fanout` でなく `span < fanout` なのは、同時発行を fanout 本以下に
    // 保つため——上流のレート制限が未知で、429 は「予算外」と誤認されて徒歩を静かに縮める
    // （#332 Codex レビュー対応。上限を上げるには先に #333 が要る）。#332 参照。
    const probes =
      span < fanout
        ? range(lo, hi)
        : [
            ...new Set(
              Array.from(
                { length: fanout },
                (_, j) => lo + Math.trunc((span * (j + 1)) / (fanout + 1)),
              ),
            ),
          ].sort((a, b) => a - b);
    const results = await Promise.all(probes.map((p) => evaluate(p)));
    // 昇順に走査し、予算内なら境界を右へ、最初の予算外で右端を確定して打ち切る
    // （単調性の仮定は直列版と同一。break 後の probe は区間更新に使わない）。
    let nextLo = lo;
    let nextHi = hi;
    let evaluated = false;
    for (let j = 0; j < probes.length; j++) {
      const arrival = results[j];
      if (arrival === null) continue; // 未評価は境界の情報ではない（#333）
      evaluated = true;
      if (arrival <= budgetMin) {
        if (best === null || probes[j] > best) best = probes[j];
        nextLo = probes[j] + 1;
      } else {
        nextHi = probes[j] - 1;
        break;
      }
    }
    // 評価できた probe が1つも無いラウンドは区間を縮められない。同じ probe を
    // 評価し直すだけなので打ち切る（判定できた probe が1つでもあれば lo か hi の
    // どちらかは必ず動くので、区間は毎ラウンド縮む）。
    if (!evaluated) break;
    lo = nextLo;
    hi = nextHi;
  }
  return best;
}

/// [from]..[to]（両端を含む）の整数列。
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/// 乗車駅探索の区間を「前半徒歩 t1 が予算内の最遠 index」までへ刈った探索点数を返す
/// （#317）。返り値 `n` は探索を index `[0, n)` に限ってよいことを表す。
///
/// **単調性に依存しない安全上界**：到着 = t1 + t2（t2 ≥ 0）なので `t1 > budgetMin` の
/// 点は到着も必ず予算外。刈るのは「t1 単独で既に予算外」の確実に無駄な引き直しだけ。
export function walkFeasiblePrefixCount(
  walk1Min: number[],
  budgetMin: number,
): number {
  let last = -1;
  for (let i = 0; i < walk1Min.length; i++) {
    if (walk1Min[i] <= budgetMin) last = i;
  }
  return last + 1;
}

/// [items] を両端を含む均等間隔で最大 [maxCount] 要素へ間引く。要素数が [maxCount]
/// 以下、または [maxCount] < 2 のときはそのまま返す（間引かない）。添字
/// `round(k*(n-1)/(maxCount-1))` で拾うため、隣接が同一添字へ丸まると重複し得る
/// （必要なら呼び出し側で dedup する）。逆戻り判定・コリドー間引き・フロンティア
/// 絞り込みが共有する均等サンプリングの単一実装（純粋関数）。
export function evenSample<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount || maxCount < 2) return items;
  return Array.from(
    { length: maxCount },
    (_, k) => items[dartRound((k * (items.length - 1)) / (maxCount - 1))],
  );
}

export interface FrontierStations {
  boarding: number[];
  alighting: number[];
}

/// 直線距離で乗降候補駅を片側 [options.maxPerSide] 個へ絞る（measure-first の
/// フロンティア絞り込み）。乗車側は origin→駅、降車側は 駅→goal の直線徒歩分を見て、
/// その**直線徒歩が予算 [budgetMin] 内**の駅だけを feasible とする。直線（haversine）は
/// 実際の道なり徒歩の下限なので、直線ですら予算を超える駅は実測しても確実に予算外＝
/// 測る価値がない。逆に直線が予算内なら、予算の大半を1本のアクセス徒歩に使う候補
/// （短い乗車＋長い徒歩）も残すため、ここでは道なり迂回の割増を掛けない（掛けると
/// 徒歩最大の正当な候補を誤って落とす）。
///
/// feasible な駅が上限を超えるときは**均等間隔で間引く（両端を含む）**。徒歩分の
/// 大きい順 top-K で間引くと、乗車側＝origin から遠い駅・降車側＝goal から遠い駅という
/// **互いに逆相関**の集合になり、同一 section・b<a の乗降ペアが作れず「中間駅で短く乗り
/// 両端を長く歩く」徒歩最大候補（ride-one-stop）を取りこぼす。両端＋中間を均等に残せば、
/// 長い片側徒歩の候補（両端）も ride-one-stop（中間）も拾い、両側のインデックス域が重なって
/// b<a ペアを保てる。駅配列の昇順インデックスで返す（下流が同一 section・b<a の乗降ペアを
/// 作るため元の順序を保つ）。
///
/// これにより origin→各乗車駅／各降車駅→goal を1回のマトリクスで一括実測する対象を
/// 要素数課金（片側 ≤ 上限）の範囲へ抑えつつ、徒歩最大の乗降候補を取りこぼさない。
/// Google を呼ばない純粋関数（データ源非依存）。
export function frontierStations(
  stops: GeoPoint[],
  origin: GeoPoint,
  goal: GeoPoint,
  budgetMin: number,
  options: { maxPerSide?: number } = {},
): FrontierStations {
  const maxPerSide = options.maxPerSide ?? 10;

  const walkMin = (a: GeoPoint, b: GeoPoint): number =>
    dartRound((haversineKm(a, b) * 1000) / walkMetersPerMinute);

  const pick = (sideWalk: (i: number) => number): number[] => {
    const feasible = stops
      .map((_, i) => i)
      .filter((i) => sideWalk(i) <= budgetMin);
    if (feasible.length <= maxPerSide || maxPerSide < 2) {
      return feasible.slice(0, Math.max(maxPerSide, 0));
    }
    // 均等間隔で maxPerSide 個（両端を含む）。中間駅を残して b<a の乗降ペアを保つ。
    // 丸めで添字が重複し得るため dedup する（feasible は昇順なので結果も昇順）。
    return [...new Set(evenSample(feasible, maxPerSide))];
  };

  return {
    boarding: pick((i) => walkMin(origin, stops[i])),
    alighting: pick((i) => walkMin(stops[i], goal)),
  };
}

/// 2点間の大圏距離（km）。徒歩区間の距離概算に用いる。
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

const earthRadiusKm = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
