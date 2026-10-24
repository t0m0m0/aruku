import { RoutePlan, type RouteSegment } from '@aruku/engine/models/route-plan';

export function planOf(segments: RouteSegment[], totalMin: number, budgetMin: number): RoutePlan {
  return new RoutePlan({
    from: '出発',
    to: '到着',
    totalKm: 0,
    totalMin,
    budgetMin,
    kcal: 0,
    walkKm: 0,
    walkRatio: 0,
    segments,
    timelineNodes: [],
  });
}
