// 厳密走査が勝った経路の便が、本当に走っているかを Transit API で照合する（#462）。
//
// 時刻表パック（ODPT の GTFS）と Transit API は別のデータ源なので、片方の取り込みの
// 誤り（サービス日・日跨ぎ・列車のつなぎ違い）はもう片方と突き合わせないと見えない。

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { SegmentType, type RouteSegment } from '@aruku/engine/models/route-plan';
import { haversineKm } from '@aruku/engine/services/hybrid-route-selector';
import type { TransitOption } from '@aruku/engine/services/transit-plan-parser';
import { dateTime } from '@aruku/engine/time';

import type { BenchRecord, BenchRide } from './bench-record';

export interface VerifyResult {
  pair: string;
  slot: string;
  ratio: number;
  line: string | null;
  from: string;
  to: string;
  dep: string | null;
  arr: string | null;
  found: boolean;
  matchedLine: string | null;
  /// 応答にあった電車・バスの区間（`HH:MM→HH:MM 路線`）。見つからなかったとき、近い便が
  /// あったのか何も無かったのかを人が見分けるため。
  seen: string[];
  error: string | null;
}

export interface RideToVerify {
  record: BenchRecord;
  ride: BenchRide;
}

/// 引き直す時刻を発車より何分前にするか。ちょうど発車時刻で引くと、照会の座標（時刻表の
/// 停留所）からホームまでの徒歩ぶん間に合わず、次の便が返り得る。
const queryLeadMin = 5;

/// 到着の許容（分）。発車は同じ分を要求する——便の同一性は発車で決まり、到着だけ
/// 緩めるのは、データ源ごとに到着の丸め（着時刻と発時刻のどちらを載せるか）が違うため。
const arrivalToleranceMin = 2;

/// 乗降の駅が同じとみなす距離（km）。時刻表の停留所の座標と、Transit API の区間ジオメトリの
/// 端点は同じ駅でもずれる（ホームの位置・駅の代表点）。隣の駅まで広げない幅にしてある。
const sameStationKm = 0.5;

/// 厳密走査が勝った1回乗車の経路を、OD が散るように上限 [limit] 件まで選ぶ。
export function ridesToVerify(records: readonly BenchRecord[], limit: number): RideToVerify[] {
  const eligible: RideToVerify[] = [];
  for (const record of records) {
    const rides = record.plan?.rides ?? [];
    const ride = rides[0];
    if (record.metrics?.['exactWon'] !== 1 || rides.length !== 1) continue;
    if (ride.fromLat === null || ride.toLat === null || ride.dep === null) continue;
    eligible.push({ record, ride });
  }
  const picked: RideToVerify[] = [];
  const seenPairs = new Set<string>();
  for (const e of eligible) {
    if (picked.length >= limit) break;
    if (seenPairs.has(e.record.pair)) continue;
    seenPairs.add(e.record.pair);
    picked.push(e);
  }
  for (const e of eligible) {
    if (picked.length >= limit) break;
    if (!picked.includes(e)) picked.push(e);
  }
  return picked;
}

export function matchRide(
  ride: BenchRide,
  options: readonly TransitOption[],
): { found: boolean; matchedLine: string | null; seen: string[] } {
  const dep = ride.dep === null ? null : parseWallClock(ride.dep);
  const arr = ride.arr === null ? null : parseWallClock(ride.arr);
  const seen: string[] = [];
  let matchedLine: string | null = null;
  let found = false;
  for (const o of options) {
    for (const s of o.segments) {
      if (s.type === SegmentType.walk || s.depTime === null || s.arrTime === null) continue;
      const label = `${hm(s.depTime)}→${hm(s.arrTime)} ${s.line ?? ''}`.trim();
      if (!seen.includes(label)) seen.push(label);
      if (found || dep === null || arr === null) continue;
      // 時刻だけで受けると、乗換を挟む経路の別の区間がたまたま同じ時刻で在るとして通る。
      if (s.type !== ride.type || !sameEndpoints(ride, s)) continue;
      const sameDeparture = s.depTime.getTime() === dep.getTime();
      const arrivalGap = Math.abs(s.arrTime.getTime() - arr.getTime()) / 60000;
      if (sameDeparture && arrivalGap <= arrivalToleranceMin) {
        found = true;
        matchedLine = s.line;
      }
    }
  }
  return { found, matchedLine, seen };
}

export interface VerifyDeps {
  fetchOptions(from: GeoPoint, to: GeoPoint, at: Date): Promise<TransitOption[]>;
  write(result: VerifyResult): void;
  shouldStop(): boolean;
}

/// 直列に照合する。理由は bench-runner.ts と同じ（第三者 API のレート制限が非公開）。
export async function runVerify(
  picked: readonly RideToVerify[],
  deps: VerifyDeps,
): Promise<void> {
  for (const { record, ride } of picked) {
    if (deps.shouldStop()) return;
    const base = {
      pair: record.pair,
      slot: record.slot,
      ratio: record.ratio,
      line: ride.line,
      from: ride.from,
      to: ride.to,
      dep: ride.dep,
      arr: ride.arr,
    };
    try {
      const options = await deps.fetchOptions(
        new GeoPoint(ride.fromLat!, ride.fromLng!),
        new GeoPoint(ride.toLat!, ride.toLng!),
        new Date(parseWallClock(ride.dep!).getTime() - queryLeadMin * 60000),
      );
      deps.write({ ...base, ...matchRide(ride, options), error: null });
    } catch (error) {
      deps.write({
        ...base,
        found: false,
        matchedLine: null,
        seen: [],
        error: String(error),
      });
    }
  }
}

function sameEndpoints(ride: BenchRide, s: RouteSegment): boolean {
  const first = s.polyline.at(0);
  const last = s.polyline.at(-1);
  if (first !== undefined && last !== undefined && ride.fromLat !== null && ride.toLat !== null) {
    return (
      haversineKm(first, new GeoPoint(ride.fromLat, ride.fromLng!)) <= sameStationKm &&
      haversineKm(last, new GeoPoint(ride.toLat, ride.toLng!)) <= sameStationKm
    );
  }
  return sameStationName(ride.from, s.fromName) && sameStationName(ride.to, s.toName);
}

/// 駅名は事業者・データ源で「駅」の有無や括弧書きの補足が揺れるので、それを落として比べる。
function sameStationName(a: string, b: string): boolean {
  const norm = (x: string): string => x.replace(/[（(].*?[)）]/g, '').replace(/駅$/, '').trim();
  return norm(a) !== '' && norm(a) === norm(b);
}

/// bench-record.ts が書いた JST の壁時計（`YYYY-MM-DDTHH:mm`）を naive な Date に戻す。
export function parseWallClock(s: string): Date {
  const [date, time] = s.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return dateTime(y, mo, d, h, mi);
}

const hm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
