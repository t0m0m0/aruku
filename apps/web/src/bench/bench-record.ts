// 厳密走査の A/B 計測（#462）の1検索ぶんを JSONL の1行にする。

import type { RoutePlan } from '@aruku/engine/models/route-plan';
import { SegmentType } from '@aruku/engine/models/route-plan';
import { firstMissedTransit } from '@aruku/engine/services/route-plan-builder';

export interface BenchRide {
  type: string;
  line: string | null;
  from: string;
  to: string;
  fromLat: number | null;
  fromLng: number | null;
  toLat: number | null;
  toLng: number | null;
  /// JST の壁時計（`YYYY-MM-DDTHH:mm`）。照合（ab-verify.ts）がこの時刻で Transit API を
  /// 引き直す。
  dep: string | null;
  arr: string | null;
}

export interface BenchPlanSummary {
  totalMin: number;
  budgetMin: number;
  walkMinutes: number;
  withinBudget: boolean;
  missed: boolean;
  rides: BenchRide[];
}

export interface BenchRecord {
  pair: string;
  date: string;
  slot: string;
  ratio: number;
  standardMin: number | null;
  budgetMin: number | null;
  metrics: Record<string, number | string> | null;
  plan: BenchPlanSummary | null;
  error: string | null;
}

/// `RouteSearchMetrics.toLogLine()` を値の表へ戻す。指標を JSONL 側で別に列挙すると、
/// 1行ログにフィールドが増えるたびに書き足し忘れる。
export function parseMetricsLine(line: string): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const pair of line.trim().split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const value = pair.slice(eq + 1);
    out[pair.slice(0, eq)] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

export function summarizePlan(plan: RoutePlan, departureAt: Date): BenchPlanSummary {
  return {
    totalMin: plan.totalMin,
    budgetMin: plan.budgetMin,
    walkMinutes: plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0),
    withinBudget: plan.totalMin <= plan.budgetMin,
    missed: firstMissedTransit(plan.segments, departureAt) !== null,
    rides: plan.segments
      .filter((s) => s.type !== SegmentType.walk)
      .map((s) => {
        const first = s.polyline.at(0) ?? null;
        const last = s.polyline.at(-1) ?? null;
        return {
          type: s.type,
          line: s.line,
          from: s.fromName,
          to: s.toName,
          fromLat: first?.lat ?? null,
          fromLng: first?.lng ?? null,
          toLat: last?.lat ?? null,
          toLng: last?.lng ?? null,
          dep: s.depTime === null ? null : wallClock(s.depTime),
          arr: s.arrTime === null ? null : wallClock(s.arrTime),
        };
      }),
  };
}

export function wallClockDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function wallClock(d: Date): string {
  return `${wallClockDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
