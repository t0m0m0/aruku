import { dartRound } from '../dart-number';
import type { JsonMap } from '../json';
import { GeoPoint } from '../models/geo-point';
import { RouteSegment, SegmentType } from '../models/route-plan';
import { haversineKm } from './hybrid-route-selector';
import { railLineLabel } from './rail-line-names';
import { dateTime } from '../time';
import { kcalPerKm, walkMetersPerMinute } from './route-plan-builder';
import { correctStationCoord } from './station-coord-corrections';

export interface TransitOptionInit {
  from: string;
  to: string;
  segments: RouteSegment[];
  corridors: TransitCorridor[];
}

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

  readonly corridors: TransitCorridor[];
}

export interface TransitCorridorInit {
  legIndex: number;
  geometrySource: string;
  coords: GeoPoint[];
}

export class TransitCorridor {
  constructor(init: TransitCorridorInit) {
    this.legIndex = init.legIndex;
    this.geometrySource = init.geometrySource;
    this.coords = init.coords;
  }

  readonly legIndex: number;
  readonly geometrySource: string;
  readonly coords: GeoPoint[];
}

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

  if (legs.some((l) => l['kind'] === 'transit' && segmentTypeForMode(l['mode']) === null)) {
    return null;
  }

  const map = opt['map'];
  const rawMapSegs = isJsonMap(map) ? map['segments'] : null;
  const mapSegs = Array.isArray(rawMapSegs) ? rawMapSegs.filter(isJsonMap) : [];

  const transitMapSegs = mapSegs.filter((s) => s['kind'] === 'transit');
  const firstTransitIdx = mapSegs.findIndex((s) => s['kind'] === 'transit');
  const lastTransitIdx = mapSegs.findLastIndex((s) => s['kind'] === 'transit');

  if (firstTransitIdx < 0) {
    const secs = truncToInt(asNum(journey['durationSecs'])) ?? 0;
    const walk = joinCoords(mapSegs.map(readWalkCoords));
    return new TransitOption({
      from: fromName,
      to: toName,
      segments: [walkSegOf(fromName, toName, secs, walk)],
      corridors: [],
    });
  }

  const transitLegs = legs.filter((l) => l['kind'] === 'transit');
  const firstBoardName =
    transitLegs.length > 0 ? (nameOf(transitLegs[0]['from']) ?? fromName) : fromName;
  const lastAlightName =
    transitLegs.length > 0 ? (nameOf(transitLegs[transitLegs.length - 1]['to']) ?? toName) : toName;

  const segments: RouteSegment[] = [];
  const corridors: TransitCorridor[] = [];

  const accessSecs = truncToInt(asNum(journey['accessWalkSecs'])) ?? 0;
  if (accessSecs > 0) {
    const walk = walkCoordsBetween(mapSegs, 0, firstTransitIdx);
    segments.push(walkSegOf(fromName, firstBoardName, accessSecs, walk));
  }

  let ti = 0;
  for (const leg of legs) {
    switch (leg['kind']) {
      case 'transit': {
        const seg = ti < transitMapSegs.length ? transitMapSegs[ti] : null;
        const coords = seg !== null ? readCoords(seg['polyline']).coords : [];
        const geom = (seg === null ? null : asString(seg['geometrySource'])) ?? '';
        const depSec = truncToInt(asNum(leg['departureSecs']));
        const arrSec = truncToInt(asNum(leg['arrivalSecs']));
        const segType = segmentTypeForMode(leg['mode']) ?? SegmentType.train;
        const routeName = asString(leg['routeName']);
        segments.push(
          new RouteSegment({
            type: segType,
            fromName: nameOf(leg['from']) ?? '',
            toName: nameOf(leg['to']) ?? '',
            minutes: diffMin(depSec, arrSec),
            km: polylineKm(coords),
            line: segType === SegmentType.bus ? routeName : railLineLabel(routeName),
            depTime: transitSecsToJst(date, depSec),
            arrTime: transitSecsToJst(date, arrSec),
            polyline: coords,
          }),
        );
        corridors.push(new TransitCorridor({ legIndex: ti, geometrySource: geom, coords }));
        ti++;
        break;
      }
      case 'walk': {
        const depSec = truncToInt(asNum(leg['departureSecs']));
        const arrSec = truncToInt(asNum(leg['arrivalSecs']));
        const secs = depSec !== null && arrSec !== null ? arrSec - depSec : 0;
        const seg = walkSegOf(
          nameOf(leg['from']) ?? '',
          nameOf(leg['to']) ?? '',
          secs,
          transferWalkCoords(mapSegs, leg),
        );
        if (!seg.isZeroWalk) segments.push(seg);
        break;
      }
    }
  }

  const egressSecs = truncToInt(asNum(journey['egressWalkSecs'])) ?? 0;
  if (egressSecs > 0) {
    const walk = walkCoordsBetween(mapSegs, lastTransitIdx + 1, mapSegs.length);
    segments.push(walkSegOf(lastAlightName, toName, egressSecs, walk));
  }

  if (segments.length === 0) return null;
  return new TransitOption({
    from: fromName,
    to: toName,
    segments,
    corridors,
  });
}

function walkSeg(fromName: string, toName: string, secs: number, coords: GeoPoint[]): RouteSegment {
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

function walkSegOf(
  fromName: string,
  toName: string,
  secs: number,
  walk: PolylineCoords,
): RouteSegment {
  if (!walk.corrected || walk.coords.length < 2) {
    return walkSeg(fromName, toName, secs, walk.coords);
  }
  const ends = [walk.coords[0], walk.coords[walk.coords.length - 1]];
  const straightSecs = ((polylineKm(ends) * 1000) / walkMetersPerMinute) * 60;
  return walkSeg(fromName, toName, straightSecs, ends);
}

function walkCoordsBetween(mapSegs: JsonMap[], start: number, end: number): PolylineCoords {
  const parts: PolylineCoords[] = [];
  for (let i = start; i < end && i < mapSegs.length; i++) {
    if (mapSegs[i]['kind'] === 'walk') parts.push(readWalkCoords(mapSegs[i]));
  }
  return joinCoords(parts);
}

function transferWalkCoords(mapSegs: JsonMap[], leg: JsonMap): PolylineCoords {
  const from = leg['from'];
  const to = leg['to'];
  const fromId = isJsonMap(from) ? from['id'] : undefined;
  const toId = isJsonMap(to) ? to['id'] : undefined;
  for (const s of mapSegs) {
    if (s['kind'] !== 'walk') continue;
    if (s['fromPointId'] === fromId && s['toPointId'] === toId) {
      return readWalkCoords(s);
    }
  }
  return { coords: [], corrected: false };
}

interface PolylineCoords {
  coords: GeoPoint[];
  corrected: boolean;
}

function readCoords(
  polyline: unknown,
  isStation: (index: number, count: number) => boolean = () => true,
): PolylineCoords {
  if (!Array.isArray(polyline)) return { coords: [], corrected: false };
  const points = polyline.filter(isJsonMap).flatMap((p) => {
    const lat = asNum(p['lat']);
    const lon = asNum(p['lon']) ?? asNum(p['lng']);
    return lat === null || lon === null ? [] : [new GeoPoint(lat, lon)];
  });
  let corrected = false;
  const coords = points.map((raw, i) => {
    const fixed = isStation(i, points.length) ? correctStationCoord(raw) : null;
    if (fixed !== null) corrected = true;
    return fixed ?? raw;
  });
  return { coords, corrected };
}

function readWalkCoords(seg: JsonMap): PolylineCoords {
  const fromStation = isStationPointId(seg['fromPointId']);
  const toStation = isStationPointId(seg['toPointId']);
  return readCoords(
    seg['polyline'],
    (i, n) => (i === 0 && fromStation) || (i === n - 1 && toStation),
  );
}

function isStationPointId(id: unknown): boolean {
  return (
    typeof id === 'string' && id !== 'origin' && id !== 'destination' && !id.startsWith('geo:')
  );
}

function joinCoords(parts: PolylineCoords[]): PolylineCoords {
  return {
    coords: parts.flatMap((p) => p.coords),
    corrected: parts.some((p) => p.corrected),
  };
}

function polylineKm(coords: GeoPoint[]): number {
  let km = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    km += haversineKm(coords[i], coords[i + 1]);
  }
  return km;
}

function diffMin(depSec: number | null, arrSec: number | null): number {
  return depSec !== null && arrSec !== null ? dartRound((arrSec - depSec) / 60) : 0;
}

function nameOf(o: unknown): string | null {
  if (!isJsonMap(o)) return null;
  const name = asString(o['name']);
  return name === null ? null : stripStationRomaji(name);
}

function isJsonMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new TypeError(`expected String, got ${typeof value}`);
}

function asNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  throw new TypeError(`expected num, got ${typeof value}`);
}

function truncToInt(value: number | null): number | null {
  return value === null ? null : Math.trunc(value);
}

export function stripStationRomaji(name: string): string {
  return name.replace(romajiSuffix, '').trim();
}

const romajiSuffix = /[\s　]+[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\s\-’']*$/;

export function transitSecsToJst(date: string | null, secs: number | null): Date | null {
  if (date === null || date.length !== 8 || secs === null) return null;
  const y = parseIntStrict(date.slice(0, 4));
  const mo = parseIntStrict(date.slice(4, 6));
  const d = parseIntStrict(date.slice(6, 8));
  if (y === null || mo === null || d === null) return null;
  return new Date(dateTime(y, mo, d).getTime() + secs * 1000);
}

function parseIntStrict(source: string): number | null {
  if (!/^[+-]?\d+$/.test(source)) return null;
  return Number.parseInt(source, 10);
}
