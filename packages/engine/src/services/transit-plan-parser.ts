// 移植元: lib/core/services/transit_plan_parser.dart

import { dartRound } from '../dart-number';
import type { JsonMap } from '../json';
import { GeoPoint } from '../models/geo-point';
import { RouteSegment, SegmentType } from '../models/route-plan';
import { haversineKm } from './hybrid-route-selector';
import { railLineLabel } from './rail-line-names';
import { dateTime } from '../time';
import { kcalPerKm } from './route-plan-builder';

export interface TransitOptionInit {
  from: string;
  to: string;
  segments: RouteSegment[];
  corridors: TransitCorridor[];
}

/// Transit API `/guidance/plan` の 1 option を解析した door-to-door 経路（#137）。
export class TransitOption {
  constructor(init: TransitOptionInit) {
    this.from = init.from;
    this.to = init.to;
    this.segments = init.segments;
    this.corridors = init.corridors;
  }

  readonly from: string;
  readonly to: string;
  readonly segments: RouteSegment[];

  /// transit 区間（電車・バス問わず）ごとのコリドー座標（origin→goal 方向に順序付き）。
  readonly corridors: TransitCorridor[];
}

export interface TransitCorridorInit {
  legIndex: number;
  geometrySource: string;
  coords: GeoPoint[];
}

/// transit 区間（電車・バス問わず。ferry/air は除外済み）の経路コリドー。
export class TransitCorridor {
  constructor(init: TransitCorridorInit) {
    this.legIndex = init.legIndex;
    this.geometrySource = init.geometrySource;
    this.coords = init.coords;
  }

  /// この区間が経路中で何本目の transit leg か（0 始まり、電車・バス問わずの通し番号）。
  readonly legIndex: number;
  readonly geometrySource: string;
  readonly coords: GeoPoint[];
}

/// `/guidance/plan` レスポンス全体を [TransitOption] 群へ解析する。
/// `options` が無い・配列でないときは空リスト。
export function parseGuidancePlan(body: JsonMap): TransitOption[] {
  const options = body['options'];
  if (!Array.isArray(options)) return [];

  const date = asString(body['date']);
  const fromName = nameOf(body['from']) ?? '出発地';
  const toName = nameOf(body['to']) ?? '目的地';

  const out: TransitOption[] = [];
  for (const o of options) {
    if (!isJsonMap(o)) continue;
    const parsed = parseOption(o, date, fromName, toName);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/// transit leg の `mode` を [SegmentType] へ写像する。`bus` は一級の [SegmentType.bus]
/// として扱う（#249、以前は option ごと除外していた＝#245）。`ferry`/`air` は
/// [SegmentType] が未対応のため引き続き option ごと除外する（`null` を返す）。
/// `mode` 欠落・`rail`/`subway` 等の未知値は後方互換として電車 (train) 扱い。
///
/// 注意: この写像は「経路として表現できるか」だけを扱う。問い合わせ条件は
/// `TransitApiClient` 側の独立した定数で決まり、主照会は `avoidModes=bus,ferry,air`
/// のままバスを含む経路を要求しない（#247）。bus leg がここへ渡るのは、電車＋徒歩が
/// 予算内に収まらないときの last-resort 再照会（`allowBus: true`・#250）の応答だけ。
function segmentTypeForMode(mode: unknown): SegmentType | null {
  if (typeof mode !== 'string') return SegmentType.train;
  switch (mode.toLowerCase()) {
    case 'bus':
      return SegmentType.bus;
    case 'ferry':
    case 'air':
      return null;
    default:
      return SegmentType.train;
  }
}

/// 1 option を解析する。`journey.legs`（時刻・路線）を本体に、`map.segments`
/// （access/egress を含む全ジオメトリ）から polyline を充てる。transit leg と
/// map の transit セグメントは同数・同順で対応する（実機検証済み）。
///
/// フェリー・航空等（[segmentTypeForMode] が `null` を返す mode）を含む itinerary は
/// [SegmentType] で表現できないため option ごと除外して `null` を返す。バスは
/// [SegmentType.bus] として表現できるため除外しない（#249。以前はバスも除外し、
/// バス停名が電車の乗車駅名へ紛れ込んでいた＝#245: バス停「山王三丁目」が
/// 京浜東北線の乗車駅として表示される）。
function parseOption(
  opt: JsonMap,
  date: string | null,
  fromName: string,
  toName: string,
): TransitOption | null {
  const journey = opt['journey'];
  if (!isJsonMap(journey)) return null;
  const rawLegs = journey['legs'];
  const legs = Array.isArray(rawLegs) ? rawLegs.filter(isJsonMap) : [];

  if (
    legs.some(
      (l) => l['kind'] === 'transit' && segmentTypeForMode(l['mode']) === null,
    )
  ) {
    return null;
  }

  const map = opt['map'];
  const rawMapSegs = isJsonMap(map) ? map['segments'] : null;
  const mapSegs = Array.isArray(rawMapSegs) ? rawMapSegs.filter(isJsonMap) : [];

  const transitMapSegs = mapSegs.filter((s) => s['kind'] === 'transit');
  const firstTransitIdx = mapSegs.findIndex((s) => s['kind'] === 'transit');
  const lastTransitIdx = mapSegs.findLastIndex((s) => s['kind'] === 'transit');

  // 電車を含まない＝全徒歩 option。単一の徒歩区間へ畳む。
  if (firstTransitIdx < 0) {
    const secs = truncToInt(asNum(journey['durationSecs'])) ?? 0;
    const coords = mapSegs.flatMap((s) => coordsOf(s['polyline']));
    return new TransitOption({
      from: fromName,
      to: toName,
      segments: [walkSeg(fromName, toName, secs, coords)],
      corridors: [],
    });
  }

  const transitLegs = legs.filter((l) => l['kind'] === 'transit');
  const firstBoardName =
    transitLegs.length > 0
      ? (nameOf(transitLegs[0]['from']) ?? fromName)
      : fromName;
  const lastAlightName =
    transitLegs.length > 0
      ? (nameOf(transitLegs[transitLegs.length - 1]['to']) ?? toName)
      : toName;

  const segments: RouteSegment[] = [];
  const corridors: TransitCorridor[] = [];

  // access walk: 最初の電車より前の徒歩セグメント群（journey.accessWalkSecs を所要に）。
  const accessSecs = truncToInt(asNum(journey['accessWalkSecs'])) ?? 0;
  if (accessSecs > 0) {
    const coords = walkCoordsBetween(mapSegs, 0, firstTransitIdx);
    segments.push(walkSeg(fromName, firstBoardName, accessSecs, coords));
  }

  let ti = 0;
  for (const leg of legs) {
    switch (leg['kind']) {
      case 'transit': {
        const seg = ti < transitMapSegs.length ? transitMapSegs[ti] : null;
        const coords = seg !== null ? coordsOf(seg['polyline']) : [];
        const geom = (seg === null ? null : asString(seg['geometrySource'])) ?? '';
        const depSec = truncToInt(asNum(leg['departureSecs']));
        const arrSec = truncToInt(asNum(leg['arrivalSecs']));
        // ferry/air は parseOption 冒頭で option ごと除外済みのため null は来ない。
        const segType = segmentTypeForMode(leg['mode']) ?? SegmentType.train;
        const routeName = asString(leg['routeName']);
        segments.push(
          new RouteSegment({
            type: segType,
            fromName: nameOf(leg['from']) ?? '',
            toName: nameOf(leg['to']) ?? '',
            minutes: diffMin(depSec, arrSec),
            km: polylineKm(coords),
            // バス系統名は電車の路線名整形（railLineLabel）の対象外。
            line: segType === SegmentType.bus ? routeName : railLineLabel(routeName),
            depTime: transitSecsToJst(date, depSec),
            arrTime: transitSecsToJst(date, arrSec),
            polyline: coords,
          }),
        );
        corridors.push(
          new TransitCorridor({ legIndex: ti, geometrySource: geom, coords }),
        );
        ti++;
        break;
      }
      case 'walk': {
        // 乗換徒歩。所要は leg の arr-dep（次電車までの待ちは含めない＝待ちは
        // 次電車の depTime で route_plan_builder が吸収する #65）。
        const depSec = truncToInt(asNum(leg['departureSecs']));
        const arrSec = truncToInt(asNum(leg['arrivalSecs']));
        const secs = depSec !== null && arrSec !== null ? arrSec - depSec : 0;
        const coords = transferWalkCoords(mapSegs, leg);
        const seg = walkSeg(
          nameOf(leg['from']) ?? '',
          nameOf(leg['to']) ?? '',
          secs,
          coords,
        );
        // 同駅乗換など距離・所要ともに実質ゼロの徒歩レッグはノイズなので生成しない（#225）。
        if (!seg.isZeroWalk) segments.push(seg);
        break;
      }
    }
  }

  // egress walk: 最後の電車より後の徒歩セグメント群（journey.egressWalkSecs を所要に）。
  const egressSecs = truncToInt(asNum(journey['egressWalkSecs'])) ?? 0;
  if (egressSecs > 0) {
    const coords = walkCoordsBetween(
      mapSegs,
      lastTransitIdx + 1,
      mapSegs.length,
    );
    segments.push(walkSeg(lastAlightName, toName, egressSecs, coords));
  }

  if (segments.length === 0) return null;
  return new TransitOption({
    from: fromName,
    to: toName,
    segments,
    corridors,
  });
}

/// 徒歩区間を作る。所要は秒→分丸め、距離は polyline 折れ線長、kcal は距離換算。
function walkSeg(
  fromName: string,
  toName: string,
  secs: number,
  coords: GeoPoint[],
): RouteSegment {
  const km = polylineKm(coords);
  return new RouteSegment({
    type: SegmentType.walk,
    fromName,
    toName,
    minutes: dartRound(secs / 60),
    km,
    kcal: dartRound(km * kcalPerKm),
    polyline: coords,
  });
}

/// [start, end) の範囲にある徒歩セグメントの polyline 座標を連結する。
function walkCoordsBetween(
  mapSegs: JsonMap[],
  start: number,
  end: number,
): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (let i = start; i < end && i < mapSegs.length; i++) {
    if (mapSegs[i]['kind'] === 'walk') out.push(...coordsOf(mapSegs[i]['polyline']));
  }
  return out;
}

/// 乗換徒歩 [leg] に対応する map の徒歩セグメント polyline を、両端の駅 id
/// （`fromPointId`/`toPointId` == `leg.from.id`/`leg.to.id`）で突き合わせて返す。
/// 一致が無ければ空（端点欠落は呼び出し側で許容）。
function transferWalkCoords(mapSegs: JsonMap[], leg: JsonMap): GeoPoint[] {
  const from = leg['from'];
  const to = leg['to'];
  const fromId = isJsonMap(from) ? from['id'] : undefined;
  const toId = isJsonMap(to) ? to['id'] : undefined;
  for (const s of mapSegs) {
    if (s['kind'] !== 'walk') continue;
    if (s['fromPointId'] === fromId && s['toPointId'] === toId) {
      return coordsOf(s['polyline']);
    }
  }
  return [];
}

/// polyline（`{lat, lon}` または point オブジェクト `{lat, lon, id, ...}` の配列）を
/// 座標列へ変換する。lat/lon を欠く要素は無視する。
function coordsOf(polyline: unknown): GeoPoint[] {
  if (!Array.isArray(polyline)) return [];
  const out: GeoPoint[] = [];
  for (const p of polyline) {
    if (!isJsonMap(p)) continue;
    const lat = asNum(p['lat']);
    const lon = asNum(p['lon']) ?? asNum(p['lng']);
    if (lat !== null && lon !== null) out.push(new GeoPoint(lat, lon));
  }
  return out;
}

/// 座標列の折れ線長（km）。2 点未満は 0。
function polylineKm(coords: GeoPoint[]): number {
  let km = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    km += haversineKm(coords[i], coords[i + 1]);
  }
  return km;
}

/// 発車秒・到着秒（サービス日 0 時起算）の差を分へ丸める。どちらか欠落なら 0。
function diffMin(depSec: number | null, arrSec: number | null): number {
  return depSec !== null && arrSec !== null ? dartRound((arrSec - depSec) / 60) : 0;
}

/// `{id, name}` 形式から name を取り出す。私鉄駅名に付くローマ字サフィックスは落とす。
function nameOf(o: unknown): string | null {
  if (!isJsonMap(o)) return null;
  const name = asString(o['name']);
  return name === null ? null : stripStationRomaji(name);
}

/// Dart の `o is Map<String, dynamic>` に対応する。配列と null を除いたオブジェクト。
function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/// Dart の `x as String?` に対応する。
///
/// 型が違えば**投げる**。無認証・無 SLA の第三者 API が相手なので黙って null へ
/// 落としたくなるが、それをやると「上流のスキーマが変わった」が
/// 「徒歩0分・路線名なしの経路が返る」という無関係な形で現れる。移植元も
/// キャストで落としており、揃えてある。
function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new TypeError(`expected String, got ${typeof value}`);
}

/// Dart の `x as num?` に対応する。型が違えば投げる（理由は [asString]）。
function asNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  throw new TypeError(`expected num, got ${typeof value}`);
}

/// Dart の `(x as num?)?.toInt()`（0 方向への切り捨て）に対応する。
function truncToInt(value: number | null): number | null {
  return value === null ? null : Math.trunc(value);
}

/// 私鉄フィードの駅名は `下北沢 Shimo-kitazawa` のように和名のあとへ空白区切りで
/// ローマ字（マクロン・ハイフンを含む）が付く。利用者表示には不要なので、和名を残して
/// 末尾のローマ字を落とす。JR の和名（ローマ字なし）はそのまま返す。
export function stripStationRomaji(name: string): string {
  return name.replace(romajiSuffix, '').trim();
}

/// 末尾の「空白＋ローマ字（ラテン文字・マクロン・ハイフン・空白）」にマッチする。
const romajiSuffix = /[\s　]+[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\s\-’']*$/;

/// サービス日 [date]（`YYYYMMDD`）の 0 時に [secs] 秒を足した naive JST の日時を
/// 返す（#137・#121）。`departureSecs`/`arrivalSecs` はサービス日 0 時起算の秒で、
/// 0 時跨ぎ便では 86400 を超え得る——経過秒の加算で翌日へ自然に繰り上がる。
///
/// 出発アンカー（ユーザー選択の壁時計値を持つローカル日時）との差が端末 TZ に依存
/// しないよう、UTC ではなくローカルの壁時計から組み立てる。UTC 起点で作ると JST 以外の
/// 端末で乗車待ちが負＝0 に化け、翌朝始発が深夜電車として表示される（#121）。
/// [date] が 8 桁でない・[secs] が null・解析不能なら null。
///
/// ここだけ暦フィールドではなく経過秒で足しているのは、移植元がそうだから
/// （`DateTime(y, mo, d).add(Duration(seconds: secs))`）。サービス日の「0 時 + 秒」は
/// 暦上の時刻ではなく**運行の経過秒**で、DST で 1 日が 23 時間になる地域では
/// 暦フィールドへ直すと逆に時刻がずれる。JST に DST は無く両者は一致する。
export function transitSecsToJst(
  date: string | null,
  secs: number | null,
): Date | null {
  if (date === null || date.length !== 8 || secs === null) return null;
  const y = parseIntStrict(date.slice(0, 4));
  const mo = parseIntStrict(date.slice(4, 6));
  const d = parseIntStrict(date.slice(6, 8));
  if (y === null || mo === null || d === null) return null;
  return new Date(dateTime(y, mo, d).getTime() + secs * 1000);
}

/// Dart の `int.tryParse` に対応する。`Number.parseInt` と違い、末尾のゴミを
/// 黙って読み飛ばさない（`'12ab'` は null）。日付は 8 桁固定の書式検査を兼ねている。
function parseIntStrict(source: string): number | null {
  if (!/^[+-]?\d+$/.test(source)) return null;
  return Number.parseInt(source, 10);
}
