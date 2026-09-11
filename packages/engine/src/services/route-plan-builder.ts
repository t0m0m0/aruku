// 移植元: lib/core/services/route_plan_builder.dart

import {
  RoutePlan,
  RouteSegment,
  SegmentType,
  TimelineNode,
} from '../models/route-plan';
import type { TimeValue } from '../models/time-value';
import { differenceInMinutes } from '../time';

/// 徒歩 1km あたりの消費カロリー。徒歩区間のみに適用する。
export const kcalPerKm = 57;

/// 徒歩の平均速度（分速メートル）。候補選定フェーズで直線距離から所要時間を
/// 概算するのに使う（不動産表示の慣行 80m/分）。確定経路の表示値は Google
/// Routes の実測へ上書きされる。
///
/// 推定は直線距離ベースで実測（道なり）より短く出る＝楽観側だが、これは意図的。
/// 採用経路は確定後に Google 実測で再判定し、超過すれば予算内へフォールバックする。
/// 再判定は「予算内と見積もった候補」を上から外す方向のみで働くため、推定を割増して
/// 足切りを厳しくすると、実測では間に合う候補を選定段階で除外しても回収できない。
export const walkMetersPerMinute = 80.0;

/// 電車の平均速度（分速メートル）。コリドー座標から合成した区間は発着時刻を持たず
/// 時刻の差で乗車時間を出せないため、折れ線長からこの速度で概算する（各停・乗換・
/// 停車を含む実効平均 30km/h ≒ 500m/分）。実発着時刻がある区間はその差を優先する。
export const trainMetersPerMinute = 500.0;

/// isNow のときは dateOffset を無視して当日扱い。budget 計算と epoch で共有。
export function effectiveOffset(t: TimeValue): number {
  return t.isNow ? 0 : t.dateOffset;
}

/// 当日0時基準の絶対分。isNow / dateOffset を踏まえ日跨ぎ計算の共通基準にする。
export function absoluteMinutes(t: TimeValue): number {
  return t.totalMinutes + effectiveOffset(t) * 24 * 60;
}

/// 出発〜到着の予算（分）。日跨ぎ（dateOffset / isNow）を考慮する。
export function budgetMinutes(
  departure: TimeValue,
  arrival: TimeValue,
): number {
  return absoluteMinutes(arrival) - absoluteMinutes(departure);
}

/// 出発時刻 + 経過分を "h:mm" へ整形（時は24で剰余）。
export function formatClock(dep: TimeValue, addMinutes: number): string {
  const total = dep.h * 60 + dep.m + addMinutes;
  const h = Math.trunc(total / 60) % 24;
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/// 出発を基点とした経過分 [cum] を、区間 [seg] を経た時点へ進める。
/// [anchor]（出発の絶対時刻）が与えられ実発車時刻 [RouteSegment.depTime] が
/// ある電車区間では、駅着から発車までの待ち時間を吸収して進める（乗車前・乗り換え待ちを
/// 到着時刻に反映する #65）。乗車時間は到着時刻 [RouteSegment.arrTime] があればその差、
/// 無ければ距離概算 [RouteSegment.minutes] を使う（コリドー由来のハイブリッド区間は
/// 実時刻検証を通るまで depTime/arrTime を持たない。#137）。
/// 戻り値の `wait` はこの区間に乗る前に待った分（タイムライン表示用）。
/// 発車時刻が欠落した区間や [anchor] 無しでは従来どおり所要分を加算し待ちは 0。
function advance(
  cum: number,
  seg: RouteSegment,
  anchor: Date | null,
): { cum: number; wait: number } {
  const dep = seg.depTime;
  const arr = seg.arrTime;
  if (anchor !== null && dep !== null) {
    const boardRel = differenceInMinutes(dep, anchor);
    // 乗車時間は到着時刻があればその差、無ければ距離概算（seg.minutes）。
    const ride =
      arr !== null ? differenceInMinutes(arr, anchor) - boardRel : seg.minutes;
    // 降車が発車より前の不整合データ（ride < 0）は所要分にフォールバックする。
    if (ride >= 0) {
      // boardRel <= cum は発車後に駅着＝乗り遅れ。ここでは待ち0で乗車時間を足す近似で
      // 進める（乗り遅れは firstMissedTransit が検知し #115 で次便の実時刻へ差し替える）。
      const wait = boardRel > cum ? boardRel - cum : 0;
      return { cum: cum + wait + ride, wait };
    }
  }
  return { cum: cum + seg.minutes, wait: 0 };
}

/// 出発を基点に全区間を進めた到着までの総所要分（時刻表が揃う電車区間では
/// 乗車前・乗り換え待ちを含む #65）。[departureAt] は出発の絶対時刻で、省略時は
/// 時刻表を使わず各区間の所要分を累積する。選定（予算判定）と表示（タイムライン）が
/// 同じ到着時刻を用いるよう、累積ロジックを [advance] に一本化して共有する。
export function arrivalMinutes(
  segments: RouteSegment[],
  departureAt: Date | null,
): number {
  let cum = 0;
  for (const seg of segments) {
    cum = advance(cum, seg, departureAt).cum;
  }
  return cum;
}

/// 徒歩実測を反映した [segments] を出発絶対時刻 [departureAt] で進め、発車時刻を持つ
/// transit 区間（電車・バス）のうち「予定の便に乗り遅れる」最初の区間の index を返す
/// （無ければ null）。
/// 乗り遅れの基準は [advance] と同一で、区間到着時点の累積分が発車相対分を超える
/// （`cum > boardRel`）こと。発車相対分ちょうどに着く場合は乗車できる扱いで対象外。
/// 判定は発車時刻のみで行う：乗り遅れとは「駅に着いたときその便が既に発車していたか」
/// であって降車時刻とは無関係だから（着時刻があれば発車前着
/// =不整合データを併せて除外する）。発車時刻が欠落した区間は判定できないため対象外。
/// バスも電車と同じ基準で判定する（#250。バス限定の緩和は入れない——時刻表を信じる
/// 決定と「その便が実在するか」の検証は別物）。
export function firstMissedTransit(
  segments: RouteSegment[],
  departureAt: Date,
): number | null {
  let cum = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dep = seg.depTime;
    const arr = seg.arrTime;
    if (isTransit(seg.type) && dep !== null) {
      const boardRel = differenceInMinutes(dep, departureAt);
      // 着時刻があれば発車前着（ride < 0）の不整合データは対象外。乗り遅れは駅着が
      // 発車相対分を超える場合のみ（同時刻は待ち0で乗車できるため除外）。
      const consistent = arr === null || arr.getTime() >= dep.getTime();
      if (consistent && cum > boardRel) return i;
    }
    cum = advance(cum, seg, departureAt).cum;
  }
  return null;
}

/// 実発車時刻（[RouteSegment.depTime]）を確認できていない transit 区間（電車・バス）を
/// 含むか。引き直しを経ても時刻が付かない区間は「その時間に便が走っている確証が無い」
/// ＝幻便の疑いで、確定経路にも代替案にも出せない（#137 深夜の幻便・#250 幽霊バス・
/// #290 代替案検証）。徒歩は時刻を持たないため対象外。
export function hasUnverifiedTransit(segments: RouteSegment[]): boolean {
  return segments.some((s) => isTransit(s.type) && s.depTime === null);
}

/// 出発から各時刻表付き transit 区間（電車・バス）に乗車するまでの待ち時間の最大値
/// （分, #121 原因②）。駅着・停留所着から発車までの待機分で、終電・終バス後は翌朝始発
/// までの長い待ちがここに表れる。複数便を含む経路では「最初の便には乗れても後続が翌朝
/// 始発」のケースを取りこぼさないよう、全 transit 区間の乗車待ちの最大を返す。時刻表の
/// 無い区間・transit を含まない経路（全徒歩）は 0。best-effort 選定で「乗車待ちが予算を
/// 超える＝今夜乗れない便」を全徒歩より後回しにする判定に使う。バスも同じ基準で数える
/// （#250。運行終了後の翌朝始発バスが待ち0に見えて全徒歩を押しのけるのを防ぐ）。
export function maxBoardingWait(
  segments: RouteSegment[],
  departureAt: Date,
): number {
  let cum = 0;
  let maxWait = 0;
  for (const seg of segments) {
    const advanced = advance(cum, seg, departureAt);
    if (isTransit(seg.type) && seg.depTime !== null && advanced.wait > maxWait) {
      maxWait = advanced.wait;
    }
    cum = advanced.cum;
  }
  return maxWait;
}

/// transit（電車・バス）区間ノードの補足文。路線名があればそれを、無ければ区間種別に
/// 応じたフォールバックを表示する（乗車前待ちは前置きしない）。walk は
/// [boardingNode] からしか呼ばれず transit 区間のみが渡るため到達しない。
function transitSub(seg: RouteSegment): string {
  if (seg.line !== null) return seg.line;
  switch (seg.type) {
    case SegmentType.train:
      return '電車';
    case SegmentType.bus:
      return 'バス';
    case SegmentType.walk:
      return '';
  }
}

/// 区間種別が transit（電車・バス）か。walk との二値網羅。
function isTransit(type: SegmentType): boolean {
  switch (type) {
    case SegmentType.walk:
      return false;
    case SegmentType.train:
    case SegmentType.bus:
      return true;
  }
}

/// 乗車駅（発）ノードを作る。表示時刻は乗車駅着の累積分 [arrivalCum] に乗車前待ちを
/// 足した「発車時刻」。早着なら発車時刻、乗り遅れ・時刻欠落なら駅着時刻に化す（advance
/// と同基準）。補足文は路線名。
function boardingNode(
  departure: TimeValue,
  place: string,
  seg: RouteSegment,
  arrivalCum: number,
  departureAt: Date | null,
): TimelineNode {
  const { wait } = advance(arrivalCum, seg, departureAt);
  return new TimelineNode({
    time: formatClock(departure, arrivalCum + wait),
    place,
    sub: transitSub(seg),
  });
}

/// 時刻表を持たない徒歩区間か。統合（[mergeConsecutiveWalks]）の可否判定に使う。
function isUntimedWalk(seg: RouteSegment): boolean {
  return (
    seg.type === SegmentType.walk &&
    seg.depTime === null &&
    seg.arrTime === null
  );
}

/// 隣り合う徒歩 [a] [b] を 1 本へ畳む。所要・距離・kcal は子の合計をそのまま持つ。
/// 距離から kcal を引き直さないのは、丸め差で合計が動くため（163+46+14=223 に対し
/// 3.9km×[kcalPerKm]=222）。polyline は順に連結し、継ぎ目が同一座標なら重複を落とす。
///
/// [b] が geometry を欠くときは連結せず空にする。polyline の末尾は引き継ぎ先（#323）と
/// 到着自動判定（#305）の両方が「この区間の終点」として読む契約なので、[a] の座標だけを
/// 残すと継ぎ目の中間点を終点と偽ることになる（Google マップを歩き終える手前へ案内し、
/// その地点で徒歩レッグ全体を完了扱いにする）。空にすれば座標不明として扱われ、
/// 次区間の始点・区間名へのフォールバックが働く。
function joinWalks(a: RouteSegment, b: RouteSegment): RouteSegment {
  const aLast = a.polyline.at(-1);
  const overlaps =
    aLast !== undefined && b.polyline.length > 0 && aLast.isAt(b.polyline[0]);
  return new RouteSegment({
    type: SegmentType.walk,
    fromName: a.fromName,
    toName: b.toName,
    minutes: a.minutes + b.minutes,
    km: a.km === null && b.km === null ? null : (a.km ?? 0) + (b.km ?? 0),
    kcal: a.kcal === null && b.kcal === null ? null : (a.kcal ?? 0) + (b.kcal ?? 0),
    polyline:
      b.polyline.length === 0
        ? []
        : [...a.polyline, ...b.polyline.slice(overlaps ? 1 : 0)],
  });
}

/// 連続する徒歩区間を 1 本へ畳む（#337）。乗車駅探索（#332）は `出発地 → 候補停留所 X`
/// の徒歩に `X → 目的地` の引き直しを継ぎ足すため、徒歩レッグが 2 本以上並ぶ。継ぎ目の
/// X は corridor 上の任意点で乗り換えも起きず、名前も持たない（`toName` が空文字のまま
/// 残る #322/#323 と同根）ため、通過点として描くと中身の無い行になる。
///
/// 畳むのは時刻を持たない徒歩どうしに限る。[RouteSegment.depTime] を持つ区間は
/// [advance] が発車待ちを吸収して進むので、畳むとその待ちが消えて到着時刻がずれる。
function mergeConsecutiveWalks(segments: RouteSegment[]): RouteSegment[] {
  const merged: RouteSegment[] = [];
  for (const seg of segments) {
    const prev = merged.length === 0 ? null : merged[merged.length - 1];
    if (prev !== null && isUntimedWalk(prev) && isUntimedWalk(seg)) {
      merged[merged.length - 1] = joinWalks(prev, seg);
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

export interface BuildRoutePlanArgs {
  from: string;
  to: string;
  segments: RouteSegment[];
  departure: TimeValue;
  budgetMin: number;

  /// 出発の絶対時刻（時刻表データとの差で待ち時間を算出する基点）。
  /// 省略時は時刻表を使わず累積所要分でタイムラインを組む。
  departureAt?: Date | null;
}

/// 区間列から RoutePlan を構築する（合計距離・徒歩距離・kcal・徒歩比率・
/// タイムライン）。データ源に依存しない純粋関数。
export function buildRoutePlan(args: BuildRoutePlanArgs): RoutePlan {
  const { from, to, departure, budgetMin } = args;
  const departureAt = args.departureAt ?? null;

  // 距離・所要ともに実質ゼロの徒歩レッグ（同駅乗換など #225）はノイズなので除外する。
  // segments と timelineNodes の 1:1 対応を保つため、ノード生成前にここで落とす。全データ源が
  // 通る共有関数なので、parser 側で漏れても表示前に確実に取り除く保険になる。
  // 統合（#337）より先に落とすのは、0値徒歩に分断されていた徒歩どうしも 1 本に畳むため。
  const segments = mergeConsecutiveWalks(
    args.segments.filter((s) => !s.isZeroWalk),
  );

  const totalKm = segments.reduce((a, s) => a + (s.km ?? 0), 0);
  const walkKm = segments
    .filter((s) => s.type === SegmentType.walk)
    .reduce((a, s) => a + (s.km ?? 0), 0);
  const kcal = segments
    .filter((s) => s.type === SegmentType.walk)
    .reduce((a, s) => a + (s.kcal ?? 0), 0);

  // 駅ごとに「着(arr)」「発(dep)」を分けて並べる（案B / Google マップ準拠）。乗車駅は
  // 発車時刻、降車駅は到着時刻を左に出す。直結乗換（電車→電車で間に徒歩が無い）でも
  // 「着」「発」の 2 行に分け、着行は cardBelow:false で次の発行へ連続させる。
  const nodes: TimelineNode[] = [
    new TimelineNode({ time: formatClock(departure, 0), place: from, sub: '出発' }),
  ];
  // from≈to の 0値ルートが 0値徒歩の除外で全滅した退化ケースでは生成ループが
  // 回らず到着ノードが欠落する。出発直後着として補い出発・到着の 2 ノードを残す。
  if (segments.length === 0) {
    nodes.push(
      new TimelineNode({
        time: formatClock(departure, 0),
        place: to,
        sub: 0 <= budgetMin ? '到着 · 制限内 ✓' : '到着',
      }),
    );
  }
  // 出発からの経過分。電車区間では待ち時間を含めて進む（#65）。
  let cum = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const cumAfter = advance(cum, seg, departureAt).cum;
    const isLast = i === segments.length - 1;
    if (isLast) {
      nodes.push(
        new TimelineNode({
          time: formatClock(departure, cumAfter),
          place: to,
          sub: cumAfter <= budgetMin ? '到着 · 制限内 ✓' : '到着',
        }),
      );
    } else {
      const next = segments[i + 1];
      const place = seg.toName;
      const incomingTransit = isTransit(seg.type);
      const outgoingTransit = isTransit(next.type);
      if (incomingTransit && outgoingTransit) {
        // 直結乗換：着行（無表示・カード無し）＋ 次のtransit区間の発行。
        nodes.push(
          new TimelineNode({
            time: formatClock(departure, cumAfter),
            place,
            sub: '',
            cardBelow: false,
          }),
        );
        nodes.push(boardingNode(departure, place, next, cumAfter, departureAt));
      } else if (outgoingTransit) {
        // 徒歩で着いて次がtransit＝乗車駅。発車時刻＋路線名（待ちがあれば前置き）。
        nodes.push(boardingNode(departure, place, next, cumAfter, departureAt));
      } else {
        // transitで着いて次が徒歩（降車駅）、または徒歩→徒歩。到着時刻に「徒歩へ」。
        nodes.push(
          new TimelineNode({
            time: formatClock(departure, cumAfter),
            place,
            sub: '徒歩へ',
          }),
        );
      }
    }
    cum = cumAfter;
  }
  // 待ち時間込みの到着までの総所要分（時刻表が無ければ累積所要分に一致する）。
  const totalMin = cum;

  return new RoutePlan({
    from,
    to,
    totalKm,
    totalMin,
    budgetMin,
    kcal,
    walkKm,
    walkRatio: totalKm === 0 ? 0 : walkKm / totalKm,
    segments,
    timelineNodes: nodes,
  });
}
