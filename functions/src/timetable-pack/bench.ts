// 時刻表パックの前処理（読み込み・運行日の組み立て）を、条件ごとに手元で測る（#487）。
//
//   npm run pack:bench -- --dir .odpt/bench [--date 20261110] [--runs 15]
//
// パックは pack:local（cli.ts）で作ったものを使う。Storage の読込はディスクからの読込に置き換わるので、
// readMs は本番の値の代わりにならない。本番の readMs は timetable_pack_load のログで見る。
//
// コールドを測るために、1回ごとに新しいプロセスで走らせる（JIT もヒープも温まっていない状態にする）。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { compileTimetable, transferNeighbors, type StationKey, type Timetable } from "../exact-scan";
import { buildScanDay } from "./day";
import { PACK_GROUPS, packObjectPath, type PackGroup } from "./feeds";
import { createScanDaySource } from "./load";
import { timetableForDate, type TimetablePack } from "./pack";
import { gunzipSync } from "node:zlib";

const SCENARIOS = ["cold", "warm", "daySwitch", "reload", "concurrent"] as const;
type Scenario = (typeof SCENARIOS)[number];
const CONCURRENT_REQUESTS = 8;
const RELOAD_AFTER_MS = 6 * 3600 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

function nextDate(yyyymmdd: string): string {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6)));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

type Sample = Record<string, number>;

/** 1つのプロセスで全ての条件を順に測る。 */
async function runOnce(dir: string, date: string): Promise<Record<Scenario, Sample>> {
  const logs: Record<string, unknown>[] = [];
  let skew = 0;
  const deps = {
    read: async (path: string) => {
      const group = PACK_GROUPS.find((g) => packObjectPath(g) === path)!;
      return new Uint8Array(readFileSync(join(dir, `${group}.json.gz`)));
    },
    log: (e: Record<string, unknown>) => logs.push(e),
    now: () => performance.now() + skew,
    heapUsed: () => process.memoryUsage().heapUsed,
  };
  const measure = async (run: () => Promise<unknown>): Promise<Sample> => {
    logs.length = 0;
    const t0 = performance.now();
    await run();
    const sample: Sample = { endpointMs: performance.now() - t0 };
    for (const e of logs) {
      const prefix = e.event === "timetable_pack_load" ? `${String(e.group)}.` : "day.";
      for (const [k, v] of Object.entries(e)) {
        if (typeof v === "number" && k.endsWith("Ms")) sample[prefix + k] = (sample[prefix + k] ?? 0) + v;
      }
    }
    sample.dayBuilds = logs.filter((e) => e.event === "timetable_day_compile").length;
    sample.heapMB = process.memoryUsage().heapUsed / 1048576;
    // maxRSS はプロセス開始からの最大なので、その条件までのピークになる。
    sample.peakRssMB = process.resourceUsage().maxRSS / 1024;
    return sample;
  };

  const source = createScanDaySource(deps);
  const cold = await measure(() => source(date));
  const warm = await measure(() => source(date));
  const daySwitch = await measure(() => source(nextDate(date)));
  skew += RELOAD_AFTER_MS;
  const reload = await measure(() => source(date));
  const fresh = createScanDaySource(deps);
  const concurrent = await measure(() =>
    Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => fresh(date))),
  );
  return { cold, warm, daySwitch, reload, concurrent };
}

/** パックを1つずつ切り出して素直に連結した時刻表と、buildScanDay の結果が一致するか。 */
function verify(dir: string, dates: string[]): boolean {
  const packs = new Map<PackGroup, TimetablePack>();
  for (const g of PACK_GROUPS) {
    packs.set(g, JSON.parse(gunzipSync(readFileSync(join(dir, `${g}.json.gz`))).toString("utf8")));
  }
  return dates.every((date) => {
    const tt: Timetable = { stops: [], trips: [] };
    const stations: StationKey[] = [];
    const feeds: { id: string; fetchedAt: string }[] = [];
    for (const g of PACK_GROUPS) {
      const p = packs.get(g)!;
      const day = timetableForDate(p, date);
      const offset = tt.stops.length;
      const feedOffset = feeds.length;
      for (const s of day.stops) {
        tt.stops.push(s);
        stations.push({ feed: s.feed + feedOffset, station: s.station });
      }
      for (const t of day.trips) {
        tt.trips.push({ ...t, calls: t.calls.map((c) => ({ ...c, stop: c.stop + offset })) });
      }
      for (const { id, fetchedAt } of p.feeds) feeds.push({ id, fetchedAt });
    }
    const compiled = compileTimetable(tt);
    const naive = {
      compiled,
      neighbors: transferNeighbors(compiled, stations, { maxWalkSec: 600 }),
      stops: tt.stops,
      feeds,
    };
    const { day } = buildScanDay(packs, date, () => 0);
    const same = isDeepStrictEqual(day, naive);
    console.error(JSON.stringify({ verify: date, same }));
    return same;
  });
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

async function main(): Promise<void> {
  const dir = arg("--dir");
  if (dir === undefined) throw new Error("--dir <パックのあるディレクトリ> を指定する");
  const date = arg("--date") ?? "20261110";
  if (process.argv.includes("--child")) {
    console.log(JSON.stringify(await runOnce(dir, date)));
    return;
  }
  if (!verify(dir, [date, nextDate(date)])) process.exitCode = 1;

  const runs = Number(arg("--runs") ?? 15);
  const samples: Record<Scenario, Sample>[] = [];
  for (let i = 0; i < runs; i++) {
    const out = execFileSync(process.execPath, [__filename, "--child", "--dir", dir, "--date", date]);
    samples.push(JSON.parse(out.toString()));
  }
  for (const scenario of SCENARIOS) {
    const keys = Object.keys(samples[0][scenario]);
    const row: Record<string, string> = { scenario };
    for (const k of keys) {
      const sorted = samples.map((s) => s[scenario][k] ?? 0).sort((a, b) => a - b);
      row[k] = `${quantile(sorted, 0.5).toFixed(0)}/${quantile(sorted, 0.95).toFixed(0)}`;
    }
    console.log(JSON.stringify(row));
  }
  console.log(`(中央値/p95, ${runs} 回, 運行日 ${date})`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
