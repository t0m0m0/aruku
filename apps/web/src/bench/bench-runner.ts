// 厳密走査の A/B 計測（#462）を直列に回す。
//
// 並列にしないのは、Transit API が第三者の API でレート制限が非公開だから
// （docs/spec/route-optimization.md §3.6「並列度」）。1検索の中でも十数本を叩く。

import { GeoPoint } from '@aruku/engine/models/geo-point';
import type { RoutePlan } from '@aruku/engine/models/route-plan';
import type { RouteSearchMetrics } from '@aruku/engine/services/route-diagnostics';
import type { PlanArgs } from '@aruku/engine/services/route-service';
import { dateTime } from '@aruku/engine/time';

import { budgetFor, timeValuesFor, type BenchSlot } from './bench-cases';
import {
  parseMetricsLine,
  summarizePlan,
  wallClockDate,
  type BenchRecord,
} from './bench-record';
import type { OdPair } from './od-pairs';

export interface BenchConfig {
  readonly pairs: readonly OdPair[];
  readonly slots: readonly BenchSlot[];
  readonly ratios: readonly number[];
  /// 走らせる日（壁時計の日付だけを使う）。
  readonly date: Date;
  /// 今日から [date] までの日数（`TimeValue.dateOffset`）。
  readonly dayOffset: number;
}

export interface BenchDeps {
  /// ふつうの乗換ルートの所要（分）。基準にできる経路が無ければ null。
  calibrate(pair: OdPair, departureAt: Date): Promise<number | null>;
  search(args: PlanArgs): Promise<{ plan: RoutePlan; metrics: RouteSearchMetrics | null }>;
  write(record: BenchRecord): void;
  shouldStop(): boolean;
  onProgress?(done: number, total: number): void;
}

export async function runBench(config: BenchConfig, deps: BenchDeps): Promise<void> {
  const total = config.pairs.length * config.slots.length * config.ratios.length;
  const date = wallClockDate(config.date);
  let done = 0;
  for (const pair of config.pairs) {
    for (const slot of config.slots) {
      if (deps.shouldStop()) return;
      const departureAt = dateTime(
        config.date.getFullYear(),
        config.date.getMonth() + 1,
        config.date.getDate(),
        slot.h,
        slot.m,
      );
      const base = { pair: pair.id, date, slot: slotLabel(slot) };
      let standardMin: number | null = null;
      let skipped = 'no-standard-route';
      try {
        standardMin = await deps.calibrate(pair, departureAt);
      } catch (error) {
        skipped = `calibrate: ${String(error)}`;
      }
      for (const ratio of config.ratios) {
        if (standardMin === null) {
          deps.write({
            ...base,
            ratio,
            standardMin: null,
            budgetMin: null,
            metrics: null,
            plan: null,
            error: skipped,
          });
          deps.onProgress?.(++done, total);
          continue;
        }
        if (deps.shouldStop()) return;
        const budgetMin = budgetFor(standardMin, ratio);
        const { departure, arrival } = timeValuesFor(config.dayOffset, slot, budgetMin);
        const record: BenchRecord = {
          ...base,
          ratio,
          standardMin,
          budgetMin,
          metrics: null,
          plan: null,
          error: null,
        };
        try {
          const { plan, metrics } = await deps.search({
            destination: pair.destination.name,
            destinationLatLng: new GeoPoint(pair.destination.lat, pair.destination.lng),
            origin: new GeoPoint(pair.origin.lat, pair.origin.lng),
            originName: pair.origin.name,
            departure,
            arrival,
          });
          record.metrics = metrics === null ? null : parseMetricsLine(metrics.toLogLine());
          record.plan = summarizePlan(plan, departureAt);
        } catch (error) {
          record.error = String(error);
        }
        deps.write(record);
        deps.onProgress?.(++done, total);
      }
    }
  }
}

const slotLabel = (s: BenchSlot): string =>
  `${String(s.h).padStart(2, '0')}:${String(s.m).padStart(2, '0')}`;
