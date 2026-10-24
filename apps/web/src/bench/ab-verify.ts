// 厳密走査が勝った経路の便が、本当に走っているかを Transit API で照合する（#462）。
//
// 時刻表パック（ODPT の GTFS）と Transit API は別のデータ源なので、片方の取り込みの
// 誤り（サービス日・日跨ぎ・列車のつなぎ違い）はもう片方と突き合わせないと見えない。
//
// 経路検索（guidance）で引き直して比べない。照会の座標から乗り場までの徒歩を Transit API が
// 自分の駅の座標で足すので、乗り場が離れて置かれた駅（三鷹の中央線快速は各停から 372m）では
// 在る便が「間に合わない」として返らず、時刻表の誤りと見分けがつかない。

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { haversineKm } from '@aruku/engine/services/hybrid-route-selector';
import { dateTime } from '@aruku/engine/time';

import type { BenchRecord, BenchRide } from './bench-record';

/// - sameTrip: 乗車駅を同じ分に発つ便が、降車駅も到着の許容内に発つ（同じ tripId）
/// - departureOnly: 乗車駅を同じ分に発つ便はあるが、降車駅の発車表で同じ便を確かめられない。
///   終点で降りる便は降車駅の発車表に載らないので、向きまでは確かめられていない
/// - missing: 乗車駅の発車表はあるが、同じ分に発つ便が無い
/// - noBoard: 乗車駅が見つからないか、発車表を出さない駅だけだった（ODPT 由来のフィードは
///   駅の発車表を公開しない）。無いとは言えない
export type VerifyVerdict = 'sameTrip' | 'departureOnly' | 'missing' | 'noBoard';

export interface VerifyResult {
  pair: string;
  slot: string;
  ratio: number;
  line: string | null;
  from: string;
  to: string;
  dep: string | null;
  arr: string | null;
  /// 照会が失敗したときは null（理由は error）。
  verdict: VerifyVerdict | null;
  /// 一致した発車の `路線 行先`。
  matchedLine: string | null;
  /// 乗車駅の発車表にあった、発車の前後の便（`HH:MM 路線 行先`）。無かったとき、近い便が
  /// あったのか何も無かったのかを人が見分けるため。
  seen: string[];
  error: string | null;
}

export interface RideToVerify {
  record: BenchRecord;
  ride: BenchRide;
}

export interface BoardStation {
  /// フィードつきの駅 ID（`feedId:stopId`）。発車表はフィードごとに引く。
  id: string;
  feedId: string;
  name: string;
  lat: number;
  lng: number;
}

export interface BoardDeparture {
  tripId: string;
  routeName: string;
  headsign: string;
  /// その日の 0 時からの秒。
  departureSecs: number;
}

/// 乗車駅の発車表を発車の何分前から引くか。手前の便も seen に出し、ずれていたとき見比べられるようにする。
const boardLookBehindMin = 2;

/// seen に出す、発車より後の幅（分）。
const seenAheadMin = 5;

/// 到着の許容（分）。発車は同じ分を要求する——便の同一性は発車で決まり、到着だけ
/// 緩めるのは、データ源ごとに到着の丸め（着時刻と発時刻のどちらを載せるか）が違うため。
/// 降車駅の発車表に載るのは着時刻でなく発時刻なので、停車時間ぶんもここで吸う。
const arrivalToleranceMin = 2;

/// 乗降の駅が同じとみなす距離（km）。時刻表の停留所の座標と、Transit API の駅の座標は
/// 同じ駅でもずれる（乗り場の位置・駅の代表点）。隣の駅まで広げない幅にしてある。
const sameStationKm = 0.5;

/// 厳密走査が勝った1回乗車の経路を、OD が散るように上限 [limit] 件まで選ぶ。
export function ridesToVerify(records: readonly BenchRecord[], limit: number): RideToVerify[] {
  const eligible: RideToVerify[] = [];
  for (const record of records) {
    const rides = record.plan?.rides ?? [];
    const ride = rides[0];
    if (record.metrics?.['exactWon'] !== 1 || rides.length !== 1) continue;
    if (ride.fromLat === null || ride.toLat === null || ride.dep === null || ride.arr === null) continue;
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

export interface VerifyDeps {
  findStations(name: string): Promise<BoardStation[]>;
  /// [date] は `YYYYMMDD`、[time] は `HH:MM`。発車表を出さない駅は null。
  fetchDepartures(stationId: string, date: string, time: string): Promise<BoardDeparture[] | null>;
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
      deps.write({ ...base, ...(await verifyRide(ride, deps)), error: null });
    } catch (error) {
      deps.write({
        ...base,
        verdict: null,
        matchedLine: null,
        seen: [],
        error: String(error),
      });
    }
  }
}

// 日を跨ぐ便（24時以降）は扱わない。ベンチの時間帯（12:00・22:00 発）の経路は日を跨がず、
// 24時以降の便を発車表がどの日付で返すかも確かめていない。
async function verifyRide(
  ride: BenchRide,
  deps: VerifyDeps,
): Promise<{ verdict: VerifyVerdict; matchedLine: string | null; seen: string[] }> {
  const dep = parseWallClock(ride.dep!);
  const arr = parseWallClock(ride.arr!);
  const boarding = sameStations(
    await deps.findStations(ride.from),
    ride.from,
    new GeoPoint(ride.fromLat!, ride.fromLng!),
  );
  const seen: string[] = [];
  if (boarding.length === 0) return { verdict: 'noBoard', matchedLine: null, seen };
  let alighting: BoardStation[] | null = null;
  let anyBoard = false;
  let departedOnly: BoardDeparture | null = null;
  for (const station of boarding) {
    const board = await deps.fetchDepartures(station.id, ymd(dep), hm(addMinutes(dep, -boardLookBehindMin)));
    if (board === null) continue;
    anyBoard = true;
    for (const d of board) {
      const offset = minuteOf(d) - minuteOfDay(dep);
      const label = `${hmSecs(d.departureSecs)} ${departureLine(d)}`;
      if (offset >= -boardLookBehindMin && offset <= seenAheadMin && !seen.includes(label)) seen.push(label);
    }
    const sameMinute = board.filter((d) => minuteOf(d) === minuteOfDay(dep));
    if (sameMinute.length === 0) continue;
    alighting ??= sameStations(
      await deps.findStations(ride.to),
      ride.to,
      new GeoPoint(ride.toLat!, ride.toLng!),
    );
    const alightingStation = alighting.find((s) => s.feedId === station.feedId);
    const alightingBoard =
      alightingStation === undefined
        ? null
        : await deps.fetchDepartures(
            alightingStation.id,
            ymd(arr),
            hm(addMinutes(arr, -arrivalToleranceMin)),
          );
    const same = sameMinute.find((d) =>
      (alightingBoard ?? []).some(
        (a) =>
          a.tripId === d.tripId &&
          Math.abs(minuteOf(a) - minuteOfDay(arr)) <= arrivalToleranceMin,
      ),
    );
    if (same !== undefined) return { verdict: 'sameTrip', matchedLine: departureLine(same), seen };
    departedOnly ??= sameMinute[0];
  }
  if (departedOnly !== null) {
    return { verdict: 'departureOnly', matchedLine: departureLine(departedOnly), seen };
  }
  return { verdict: anyBoard ? 'missing' : 'noBoard', matchedLine: null, seen };
}

/// 名前が同じで、時刻表の停留所から [sameStationKm] 以内の駅を近い順に。名前だけだと
/// 遠くの同名のバス停を、距離だけだと隣接する別名の駅（新宿と新宿三丁目）を拾う。
function sameStations(stations: readonly BoardStation[], name: string, at: GeoPoint): BoardStation[] {
  return stations
    .filter((s) => sameStationName(s.name, name))
    .map((s) => ({ s, km: haversineKm(at, new GeoPoint(s.lat, s.lng)) }))
    .filter(({ km }) => km <= sameStationKm)
    .sort((a, b) => a.km - b.km)
    .map(({ s }) => s);
}

/// 駅名は事業者・データ源で「駅」の有無や括弧書きの補足、ローマ字の併記（`新宿 Shinjuku`）が
/// 揺れるので、それを落として比べる。
function sameStationName(a: string, b: string): boolean {
  const norm = (x: string): string =>
    x
      .replace(/[（(].*?[)）]/g, '')
      .replace(/\s+(?=[A-Za-z\u00C0-\u024F]).*$/, '')
      .trim()
      .replace(/駅$/, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

const departureLine = (d: BoardDeparture): string => `${d.routeName} ${d.headsign}`.trim();

const minuteOf = (d: BoardDeparture): number => Math.floor(d.departureSecs / 60);

const minuteOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();

const addMinutes = (d: Date, minutes: number): Date =>
  dateTime(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes() + minutes);

const pad = (n: number): string => String(n).padStart(2, '0');

const ymd = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

const hm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const hmSecs = (secs: number): string => `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}`;

/// bench-record.ts が書いた JST の壁時計（`YYYY-MM-DDTHH:mm`）を naive な Date に戻す。
export function parseWallClock(s: string): Date {
  const [date, time] = s.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return dateTime(y, mo, d, h, mi);
}
