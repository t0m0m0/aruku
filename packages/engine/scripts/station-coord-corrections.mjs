// Transit API が返す JR 東日本の駅座標を mini-tokyo-3d の駅座標と突き合わせ、ずれの大きい駅の
// 補正表 src/services/station-coord-table.ts を作り直す（#515）。
//
//   node packages/engine/scripts/station-coord-corrections.mjs
//
// Transit API の /locations/suggest を駅名ごとに1本ずつ（数百本）叩く。第三者の無料 API なので、
// 並列度は低く抑えてある。上流が座標を直した駅は表から落ちるので、ときどき回して差分を見る。

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// functions/src/timetable-pack/feeds.ts の時刻表パックと同じ版に揃える。
const M3D_COMMIT = 'fa7833f18a288aeca171b68892bb7f67e229e4ca';
const M3D_STATIONS = `https://raw.githubusercontent.com/nagix/mini-tokyo-3d/${M3D_COMMIT}/data/stations.json`;
const SUGGEST = 'https://api.transit.ls8h.com/api/v1/locations/suggest';

// 数百 m の差はホームの位置や駅舎の大きさの差と見分けられないので、補正しない。
const MIN_OFFSET_M = 500;
// これより遠い同名の駅は、ずれではなく別の駅（福島の根岸と横浜の根岸など）とみなす。
const MAX_OFFSET_M = 5000;
const CONCURRENCY = 3;

const outPath = fileURLToPath(new URL('../src/services/station-coord-table.ts', import.meta.url));

function haversineM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  // src/services/hybrid-route-selector.ts の haversineKm と同じ半径。
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round5 = (x) => Math.round(x * 1e5) / 1e5;

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt >= 3) throw new Error(`${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

const m3d = await getJson(M3D_STATIONS);
const m3dByName = new Map();
for (const s of m3d) {
  // 範囲外の駅は座標を持たない（路線の端だけ名前を載せている）。
  if (!s.id.startsWith('JR-East.') || s.coord === undefined) continue;
  const name = s.title.ja;
  if (!m3dByName.has(name)) m3dByName.set(name, []);
  m3dByName.get(name).push({ lat: s.coord[1], lon: s.coord[0] });
}

const names = [...m3dByName.keys()];
const corrections = new Map();
const excluded = [];
let next = 0;
let done = 0;

async function worker() {
  while (next < names.length) {
    const name = names[next++];
    const url = `${SUGGEST}?q=${encodeURIComponent(name)}&limit=30`;
    const body = await getJson(url);
    for (const st of body.stations ?? []) {
      if (st.kind !== 'station' || st.name !== name) continue;
      if (!String(st.feedId).includes('jreast')) continue;
      let best = null;
      for (const ref of m3dByName.get(name)) {
        const d = haversineM(st.lat, st.lon, ref.lat, ref.lon);
        if (best === null || d < best.d) best = { d, ref };
      }
      if (best.d <= MIN_OFFSET_M) continue;
      if (best.d > MAX_OFFSET_M) {
        excluded.push(`${st.id} ${name} ${Math.round(best.d)}m`);
        continue;
      }
      const from = [round5(st.lat), round5(st.lon)];
      const to = [round5(best.ref.lat), round5(best.ref.lon)];
      const key = from.join(',');
      if (corrections.has(key)) continue;
      corrections.set(key, {
        station: st.id,
        name,
        from,
        to,
        offsetM: Math.round(haversineM(from[0], from[1], to[0], to[1])),
      });
    }
    done++;
    if (done % 50 === 0) console.error(`${done}/${names.length}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const rows = [...corrections.values()].sort((a, b) =>
  a.station < b.station ? -1 : a.station > b.station ? 1 : 0,
);
const lines = rows.map(
  (r) =>
    `  { station: '${r.station}', name: '${r.name}', from: [${r.from.join(', ')}], to: [${r.to.join(', ')}], offsetM: ${r.offsetM} },`,
);
const source = `// 生成物。手で直さず node packages/engine/scripts/station-coord-corrections.mjs で作り直す（#515）。
//
// 正しい座標（to）は mini-tokyo-3d の data/stations.json（commit ${M3D_COMMIT}）による。
// mini-tokyo-3d: The MIT License (MIT), Copyright (c) 2019-2026 Akihiko Kusanagi

import type { StationCoordCorrection } from './station-coord-corrections';

export const stationCoordTable: readonly StationCoordCorrection[] = [
${lines.join('\n')}
];
`;
await writeFile(outPath, source);
console.error(`${rows.length} corrections written to ${outPath}`);
if (excluded.length > 0) {
  console.error(`excluded as same-name different stations (> ${MAX_OFFSET_M}m):`);
  for (const e of excluded) console.error(`  ${e}`);
}
