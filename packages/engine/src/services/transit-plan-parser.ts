// 移植元: lib/core/services/transit_plan_parser.dart

import type { JsonMap } from '../json';
import type { GeoPoint } from '../models/geo-point';
import type { RouteSegment } from '../models/route-plan';
import { notImplemented } from '../not-implemented';

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
  return notImplemented(`parseGuidancePlan(${Object.keys(body).join(',')})`);
}

/// 私鉄フィードの駅名に付く末尾のローマ字サフィックスを落とす。
export function stripStationRomaji(name: string): string {
  return notImplemented(`stripStationRomaji(${name})`);
}

/// サービス日 [date]（`YYYYMMDD`）の 0 時に [secs] 秒を足したローカル日時を返す
/// （#137・#121）。[date] が 8 桁でない・[secs] が null・解析不能なら null。
export function transitSecsToJst(
  date: string | null,
  secs: number | null,
): Date | null {
  return notImplemented(`transitSecsToJst(${date}, ${secs})`);
}
