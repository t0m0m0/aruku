// 移植元: lib/shared/extensions/route_map_overlays.dart

import type { RoutePlan } from '@aruku/engine/models/route-plan';
import { SegmentType } from '@aruku/engine/models/route-plan';

/// ArukuTokens.routeWalk / routeTrain。tokens.css の --moss-500 / --train と同じ値だが、
/// CSS 変数では解決しない——Google Maps は polyline の色を文字列で受け取り、
/// `var(--moss-500)` を読める DOM の外に居る。
const walkColor = '#4F9527';
const transitColor = '#3E6792';

/// google.maps.LatLngLiteral と同じ形。Maps API の型に依存しないのは、この層が
/// jsdom（Maps API が存在しない）でも動く必要があるため。
export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export interface RouteBounds {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export interface RouteOverlayPath {
  readonly id: string;
  readonly points: LatLng[];
  readonly strokeColor: string;
  readonly strokeWeight: number;
  /// 破線の刻み（px）。実線なら null。
  ///
  /// google.maps の icons/repeat へ畳まずに寸法のまま持つ。畳むと Maps API の
  /// シンボル定数がこのモジュールへ入り、jsdom で読めなくなる。
  readonly dash: { readonly length: number; readonly gap: number } | null;
}

export function toOverlayPaths(route: RoutePlan): RouteOverlayPath[] {
  const paths: RouteOverlayPath[] = [];
  route.segments.forEach((seg, i) => {
    if (seg.polyline.length === 0) return;
    const isWalk = seg.type === SegmentType.walk;
    paths.push({
      id: `seg-${i}`,
      points: seg.polyline.map((p) => ({ lat: p.lat, lng: p.lng })),
      strokeColor: isWalk ? walkColor : transitColor,
      strokeWeight: isWalk ? 5 : 6,
      dash: isWalk ? { length: 20, gap: 12 } : null,
    });
  });
  return paths;
}

function allPoints(route: RoutePlan): LatLng[] {
  return route.segments.flatMap((seg) =>
    seg.polyline.map((p) => ({ lat: p.lat, lng: p.lng })),
  );
}

export function toEndpoints(
  route: RoutePlan,
): { start: LatLng; end: LatLng } | null {
  const points = allPoints(route);
  if (points.length === 0) return null;
  return { start: points[0]!, end: points[points.length - 1]! };
}

export function toBounds(route: RoutePlan): RouteBounds | null {
  const points = allPoints(route);
  if (points.length === 0) return null;
  // Math.min(...lats) で書かない。経路の polyline は区間ごとに数千点になり得て、
  // 展開した引数は呼び出しスタックに載る——上限を越えると RangeError で落ちる。
  let box = {
    south: points[0]!.lat,
    west: points[0]!.lng,
    north: points[0]!.lat,
    east: points[0]!.lng,
  };
  for (const p of points) {
    box = {
      south: Math.min(box.south, p.lat),
      west: Math.min(box.west, p.lng),
      north: Math.max(box.north, p.lat),
      east: Math.max(box.east, p.lng),
    };
  }
  return box;
}

export function boundsEqual(a: RouteBounds | null, b: RouteBounds | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.south === b.south &&
    a.west === b.west &&
    a.north === b.north &&
    a.east === b.east
  );
}
