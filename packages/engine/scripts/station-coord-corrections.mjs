/// <reference types="node" />

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const M3D_COMMIT = 'fa7833f18a288aeca171b68892bb7f67e229e4ca';
const M3D_STATIONS = `https://raw.githubusercontent.com/nagix/mini-tokyo-3d/${M3D_COMMIT}/data/stations.json`;
const SUGGEST = 'https://api.transit.ls8h.com/api/v1/locations/suggest';

const MIN_OFFSET_M = 500;
const MAX_OFFSET_M = 5000;
const CONCURRENCY = 3;

const outPath = fileURLToPath(new URL('../src/services/station-coord-table.ts', import.meta.url));

function haversineM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round5 = (x) => Math.round(x * 1e5) / 1e5;

/**
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      /** @type {unknown} */
      const body = await res.json();
      return body;
    }
    if (attempt >= 3) throw new Error(`${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown} body
 * @returns {{ name: string, lat: number, lon: number }[]}
 */
function parseM3dStations(body) {
  if (!Array.isArray(body)) throw new Error('stations.json is not an array');
  /** @type {unknown[]} */
  const stations = body;
  /** @type {{ name: string, lat: number, lon: number }[]} */
  const out = [];
  for (const s of stations) {
    if (!isRecord(s) || typeof s.id !== 'string' || !s.id.startsWith('JR-East.')) continue;
    if (!Array.isArray(s.coord)) continue;
    /** @type {unknown[]} */
    const coord = s.coord;
    const [lon, lat] = coord;
    const name = isRecord(s.title) ? s.title.ja : undefined;
    if (typeof name !== 'string' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    out.push({ name, lat, lon });
  }
  return out;
}

/**
 * @param {unknown} body
 * @returns {{ id: string, name: string, feedId: string, lat: number, lon: number }[]}
 */
function parseSuggestStations(body) {
  if (!isRecord(body) || !Array.isArray(body.stations)) return [];
  /** @type {{ id: string, name: string, feedId: string, lat: number, lon: number }[]} */
  const out = [];
  /** @type {unknown[]} */
  const stations = body.stations;
  for (const st of stations) {
    if (!isRecord(st) || st.kind !== 'station') continue;
    const { id, name, feedId, lat, lon } = st;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    out.push({ id, name, feedId: String(feedId), lat, lon });
  }
  return out;
}

/** @type {Map<string, { lat: number, lon: number }[]>} */
const m3dByName = new Map();
for (const { name, lat, lon } of parseM3dStations(await getJson(M3D_STATIONS))) {
  const refs = m3dByName.get(name) ?? [];
  refs.push({ lat, lon });
  m3dByName.set(name, refs);
}

const names = [...m3dByName.keys()];
/** @type {Map<string, { station: string, name: string, from: number[], to: number[], offsetM: number }>} */
const corrections = new Map();
const excluded = [];
let next = 0;
let done = 0;

async function worker() {
  while (next < names.length) {
    const name = names[next++];
    const url = `${SUGGEST}?q=${encodeURIComponent(name)}&limit=30`;
    for (const st of parseSuggestStations(await getJson(url))) {
      if (st.name !== name) continue;
      if (!st.feedId.includes('jreast')) continue;
      let best = null;
      for (const ref of m3dByName.get(name) ?? []) {
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

import type { StationCoordCorrection } from '../models/station-coord-correction';

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
