// 定期関数 refreshTimetablePacks と同じ処理を手元で回し、パックのサイズと読み込み時間を測る。
//
//   ODPT_CENTER_KEY="$(gcloud secrets versions access latest --secret ODPT_CENTER_KEY --project aruku-app)" \
//   ODPT_CHALLENGE_KEY="$(gcloud secrets versions access latest --secret ODPT_CHALLENGE_KEY --project aruku-app)" \
//     npm run pack:local -- --out .odpt [--feeds Toei,TokyoMetro]
//
// 出力先は .gitignore 済みの場所にする。GTFS もパックもリポジトリに入れない
// （基本ライセンス第8条4(1)・チャレンジ限定データの第三者提供の禁止）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { compileTimetable } from "../exact-scan";
import { ODPT_FEEDS } from "./feeds";
import { timetableForDate, type TimetablePack } from "./pack";
import { refreshTimetablePacks } from "./refresh";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

function todayInJapan(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10).replace(/-/g, "");
}

async function main(): Promise<void> {
  const out = arg("--out");
  if (out === undefined) throw new Error("--out <dir> を指定する");
  const only = arg("--feeds")?.split(",");
  const feeds = only === undefined ? ODPT_FEEDS : ODPT_FEEDS.filter((f) => only.includes(f.id));

  const written: string[] = [];
  const results = await refreshTimetablePacks(
    {
      fetch: (url) => fetch(url),
      keys: {
        ODPT_CENTER_KEY: process.env.ODPT_CENTER_KEY,
        ODPT_CHALLENGE_KEY: process.env.ODPT_CHALLENGE_KEY,
      },
      now: () => new Date(),
      upload: async (path, gzipped) => {
        const file = join(out, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, gzipped);
        written.push(file);
      },
      log: (event) => console.error(JSON.stringify(event)),
    },
    feeds,
  );

  const date = todayInJapan();
  for (const file of written) {
    const gzipped = readFileSync(file);
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const pack = JSON.parse(gunzipSync(gzipped).toString()) as TimetablePack;
    const t1 = performance.now();
    const day = timetableForDate(pack, date);
    const t2 = performance.now();
    const ct = compileTimetable(day);
    const t3 = performance.now();
    console.log(
      JSON.stringify({
        file,
        gzipKB: Math.round(gzipped.byteLength / 1024),
        feeds: pack.feeds.map((f) => f.id),
        stops: pack.stops.length,
        stations: pack.stations.length,
        trips: pack.trips.length,
        date,
        dayTrips: day.trips.length,
        dayCalls: ct.callStop.length,
        loadMs: Math.round(t1 - t0),
        dayMs: Math.round(t2 - t1),
        compileMs: Math.round(t3 - t2),
        heapMB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1048576),
      }),
    );
  }
  if (results.some((r) => r.status === "skipped")) process.exitCode = 1;
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
