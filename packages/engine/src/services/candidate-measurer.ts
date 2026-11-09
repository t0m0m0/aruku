import { dartRound } from '../dart-number';
import { intOr, isRecord, type JsonMap } from '../json';
import { GeoPoint } from '../models/geo-point';
import { RouteSegment, SegmentType } from '../models/route-plan';
import { decodePolyline } from '../polyline';
import { startedStopwatch } from '../stopwatch';
import { plusMinutes } from '../time';
import { parseDurationMin, walkCacheKey } from './access-walk-matrix';
import { SearchCanceledException } from './cancellation';
import {
  measureShortlist,
  reachableWithinBudget,
  RouteCandidate,
} from './hybrid-route-selector';
import {
  BestEffortLedger,
  EnrichLatencyLedger,
  RouteDiagnostics,
} from './route-diagnostics';
import {
  arrivalMinutes,
  firstMissedTransit,
  hasUnverifiedTransit,
  kcalPerKm,
} from './route-plan-builder';
import { RouteException } from './route-service';
import type { LastResortBus, SearchSession, WalkLegCache } from './search-session';
import type { TransitApiClient } from './transit-api-client';
import { parseGuidancePlan, type TransitOption } from './transit-plan-parser';

/// 選定・enrich 検証の結果一式。[chosen] は enrich 前の選定候補（guidance 見積りのまま）、
/// [enriched] は Google 実測で確定した採用経路。
export interface Selection {
  chosen: RouteCandidate;
  enriched: RouteCandidate;
}

/// 見積り予算内候補を1回の並列パスで実測する短リストの本数上限（#315）。
/// 上限はレート制限（#161: 1検索最大13ファンアウト）に合わせる。
export const maxMeasureShortlist = 13;

/// 候補の実測と確定（#486 で [TransitRouteService] から分けた）。徒歩を Google で測り、
/// 時刻なしの transit 区間へ実発車時刻を当て、確定不変条件（#254）に反する候補を棄却して
/// 選び直す。どの候補を足すか・いつ測るかは知らない——それは検索の進行（呼び出し側）の仕事。
export class CandidateMeasurer {
  constructor(
    private readonly api: TransitApiClient,
    private readonly diag: RouteDiagnostics,
  ) {}

  /// 候補から決定的に選定し、採用1経路を Google 実測（enrich）で検証する確定ループ。
  /// **乗り遅れ再照会（#115）は行わない**：enrich で (a) 予算超過、または (b) 先頭電車に
  /// 乗り遅れが判明した候補は除外して乗れる次善へ選び直す。除外しきれないときは確定させず
  /// best-effort へ縮退する（#254）。
  ///
  /// `bus` を渡すと、縮退した best-effort が**なお予算外か乗り遅れる**ときに限り
  /// 採用し、得られた候補をプールへ足して選定をやり直す（#250）。
  ///
  /// 台帳を `session` から取らずに受け取るのは、A/B 計測（#462）の選び直しが同じキャッシュで
  /// 別の台帳へ積むため。
  async selectAndEnrich(
    candidates: RouteCandidate[],
    budgetMin: number,
    departureAt: Date,
    ctx: {
      origin: GeoPoint;
      goal: GeoPoint;
      session: SearchSession;
      enrichLedger: EnrichLatencyLedger;
      bestEffortLedger: BestEffortLedger;
      bus?: LastResortBus;
      /// 実測して落ちた候補を積む先。呼び出し側が数える（A/B の `transferDropped`）。
      rejected?: Set<RouteCandidate>;
    },
  ): Promise<Selection> {
    const { origin, goal, session, enrichLedger, bestEffortLedger } = ctx;
    const rejected = ctx.rejected ?? new Set<RouteCandidate>();

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
      ctx.bus?.prefetch();
      const fallback = await this.bestEffortResolved(
        candidates,
        budgetMin,
        departureAt,
        session.walkCache,
        bestEffortLedger,
      );
      const segs = fallback.enriched.segments;
      const arrival = arrivalMinutes(segs, departureAt);
      const missed = firstMissedTransit(segs, departureAt) !== null;
      if (ctx.bus === undefined) return fallback;
      if (arrival <= budgetMin && !missed) {
        this.diag.log(
          () => `  → best-effort が予算内(arr=${arrival}m) → バス再照会せず`,
        );
        return fallback;
      }
      const bus = await ctx.bus.adopt();
      // 再入時（バス追加後の選び直しから再び縮退したとき）に同じ候補を積み増さない。
      // 下の選び直しへ `bus` を渡さないのも同じ理由（照会は高々1回）。
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
          session,
          enrichLedger,
          bestEffortLedger,
          rejected,
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
          this.measureOrDrop(c, departureAt, session, enrichLedger),
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

  /// 候補1件を実測（enrich 徒歩＋実発車時刻解決）し、[SearchSession.enrichedCache] へ
  /// identity でメモ化する（#315）。
  async measureCandidate(
    c: RouteCandidate,
    departureAt: Date,
    session: SearchSession,
    ledger: EnrichLatencyLedger,
  ): Promise<RouteCandidate> {
    const hit = session.enrichedCache.get(c);
    // キャッシュヒットは壁時計を払っていないので台帳へ入れない。入れると「本数×段数」の
    // 分母が水増しされ、ファンアウトの実コストを読み違える。
    if (hit !== undefined) return hit;
    const sw = startedStopwatch();
    // 徒歩 enrich と引き直しは厳密な直列なので、内側の await を別時計で挟むだけで内訳が割れる。
    const walkSw = startedStopwatch();
    let steps = 0;
    try {
      const walked = await this.enrichWalkGeometry(c, session.walkCache);
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
      session.enrichedCache.set(c, e);
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
  async measureOrDrop(
    c: RouteCandidate,
    departureAt: Date,
    session: SearchSession,
    ledger: EnrichLatencyLedger,
  ): Promise<RouteCandidate | null> {
    try {
      return await this.measureCandidate(c, departureAt, session, ledger);
    } catch (error) {
      if (error instanceof SearchCanceledException) throw error;
      return null;
    }
  }

  /// 乗換の徒歩を実測できた候補だけを残す。実測に失敗した徒歩は見積りのまま残るが
  /// （[enrichWalkGeometry]）、乗換の徒歩はサーバも測っていない直線の見積りなので、
  /// 残すと [firstMissedTransit] が乗れない接続を通す。選定の中で弾かないのは、best-effort
  /// 縮退にも同じ判定が要るため。測った値は [walkCache] に残るので、enrich は投げ直さない。
  async withMeasuredTransferWalks(
    candidates: RouteCandidate[],
    walkCache: WalkLegCache,
  ): Promise<RouteCandidate[]> {
    const measured = await Promise.all(
      candidates.map(async (c) => {
        const walks = c.segments.filter(
          (s, i, segs) =>
            s.type === SegmentType.walk &&
            i > 0 &&
            i < segs.length - 1 &&
            segs[i - 1].type !== SegmentType.walk &&
            segs[i + 1].type !== SegmentType.walk,
        );
        const legs = await Promise.all(
          walks.map((s) =>
            this.tryWalk(s.polyline[0], s.polyline[1], s.fromName, s.toName, walkCache),
          ),
        );
        return legs.every((leg) => leg !== null);
      }),
    );
    return candidates.filter((_, i) => measured[i]);
  }

  /// 確定経路の徒歩区間を Google Routes の街路ジオメトリ・所要・距離で上書きする。
  /// 取得失敗時は元（guidance の polyline / 直線）を保つ。
  async enrichWalkGeometry(
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

  /// origin→dest の徒歩を Google Routes(WALK, プロキシ経由)で取得して徒歩区間候補にする。
  /// レッグ単位キャッシュ（座標5桁丸めキー）。失敗時は null。
  async tryWalk(
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

  /// approach A（時刻なしハイブリッドの実時刻検証）。コリドー由来の電車区間は距離概算の
  /// minutes だけを持ち depTime を欠くため、乗車待ち（終電後・運行時間外の翌朝始発待ちを
  /// 含む）が [arrivalMinutes] に反映されず、走っていない電車が予算内へ化ける（#137）。
  /// 採用候補の時刻なし transit 区間について、乗車座標→降車座標を実 boardAt で引き直し、
  /// 最初の同種 leg の実発着時刻を当てる。boardAt より前発・取得失敗・同種の便なしの区間は
  /// 当てない。駅名も同時に復元する。バス区間も同じ検証に掛ける（#250）。
  async resolveBoardingTimes(
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
  async fetchTransitEndpoints(
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
      ? comparableFrom(direct, at)
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
    const best = earliestArrival(named.length > 0 ? named : shortest, at);
    if (best === null) return null;
    const leg = firstOfType(best, type);
    return {
      from: leg.fromName,
      to: leg.toName,
      dep: leg.depTime,
      arr: leg.arrTime,
    };
  }

  /// 確定経路の transit 区間に乗降地名が無い（コリドー座標由来の候補）ときだけ、その乗車座標
  /// →降車座標で `/guidance/plan` を1回引き直して leg の実駅名・バス停名を復元する。
  /// 続けて隣接徒歩区間の端点へ地名を伝播する。バス区間も対象にする（#251）。
  async finalizeStationNames(
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

  /// transit 区間の乗降地名を、直前（乗車側）・直後（降車側）の徒歩区間の端点が空のときだけ
  /// 写す。徒歩区間の端点名は結果画面（Google マップへの引き継ぎの読み上げ名など）に出るため。
  /// タイムラインの乗車ノードの駅名は電車区間の fromName を直接読むので、これに頼らない。
  /// 出発地・目的地の端（非空）は上書きしない。
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
}

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
export function comparableFrom(options: TransitOption[], at: Date): TransitOption[] {
  const comparable = options.filter((o) => isComparableOption(o, at));
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
export function earliestArrival(
  options: TransitOption[],
  at: Date,
): TransitOption | null {
  let best: TransitOption | null = null;
  let bestArr = 0;
  for (const o of comparableFrom(options, at)) {
    const arr = arrivalMinutes(o.segments, at);
    if (best === null || arr < bestArr) {
      best = o;
      bestArr = arr;
    }
  }
  return best;
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

/// [comparableFrom] の条件。
export function isComparableOption(o: TransitOption, at: Date): boolean {
  return o.segments.every(hasUsableTimes) && firstMissedTransit(o.segments, at) === null;
}

function hasUsableTimes(s: RouteSegment): boolean {
  if (s.type === SegmentType.walk) return s.minutes >= 0;
  const dep = s.depTime;
  const arr = s.arrTime;
  return dep !== null && arr !== null && arr.getTime() >= dep.getTime();
}

/// option の [type] 区間のうち最初の1本。呼び出し側は事前に「[type] が1本だけ」を
/// 確かめている（[CandidateMeasurer.fetchTransitEndpoints]）。
function firstOfType(o: TransitOption, type: SegmentType): RouteSegment {
  const leg = o.segments.find((s) => s.type === type);
  if (leg === undefined) {
    throw new Error(`no ${type} segment in option`);
  }
  return leg;
}

function parseEncodedPolyline(polyline: unknown): GeoPoint[] {
  const encoded = isRecord(polyline) ? polyline['encodedPolyline'] : null;
  if (typeof encoded !== 'string' || encoded.length === 0) return [];
  return decodePolyline(encoded).map(([lat, lng]) => new GeoPoint(lat, lng));
}
