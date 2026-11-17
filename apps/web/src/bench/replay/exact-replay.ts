// 再生ハーネス（#504）で、厳密走査 `exactWalkMax` の照会に手元の時刻表パックで答える（#513）。
//
// 本物のエンドポイントは App Check を要求し、ブラウザの外からは叩けない。functions の
// findExactWalkMax と同じパックの読み込みをこのプロセスで回し、徒歩は徒歩プロキシと同じ
// 合成の値で測る。パックは `npm run pack:local` の出力（グループごとの
// `<dir>/<group>/timetable-pack.json.gz`）をそのまま読む。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import {
  findExactWalkMax,
  parseExactWalkMaxQuery,
  type MatrixElement,
} from '../../../../../functions/src/exact-walk-max';
import { createScanDaySource } from '../../../../../functions/src/timetable-pack/load';
import { syntheticWalkMeters, syntheticWalkSeconds } from './synthetic-walk';

export interface ExactReplayResponse {
  readonly status: number;
  readonly body: string;
}

export function packDirReader(dir: string): (path: string) => Promise<Uint8Array | null> {
  return (path) => {
    const file = join(dir, path);
    return Promise.resolve(existsSync(file) ? new Uint8Array(readFileSync(file)) : null);
  };
}

export interface LocalExactWalkMaxInit {
  readonly packDir: string;
  /// departAt の範囲（今から1日前〜92日先）を測る基準。ハーネスでは出発日を渡す。
  readonly now: () => Date;
}

/// exactWalkMax の照会 URL に、本番のハンドラと同じ状態コードと本文で答える関数。
export function localExactWalkMax(
  init: LocalExactWalkMaxInit,
): (url: URL) => Promise<ExactReplayResponse> {
  const day = createScanDaySource({
    read: packDirReader(init.packDir),
    log: () => undefined,
    now: () => Date.now(),
  });
  return async (url) => {
    const parsed = parseExactWalkMaxQuery(Object.fromEntries(url.searchParams), init.now());
    if ('error' in parsed) return { status: 400, body: JSON.stringify({ error: parsed.error }) };
    const body = await findExactWalkMax(parsed, { day, measure: syntheticMatrix });
    if (body === null)
      return { status: 503, body: JSON.stringify({ error: 'timetable unavailable' }) };
    return { status: 200, body: JSON.stringify(body) };
  };
}

function syntheticMatrix(
  origins: { lat: number; lng: number }[],
  destinations: { lat: number; lng: number }[],
): Promise<MatrixElement[]> {
  const elements = origins.flatMap((o, originIndex) =>
    destinations.map((d, destinationIndex) => {
      const a = new GeoPoint(o.lat, o.lng);
      const b = new GeoPoint(d.lat, d.lng);
      return {
        originIndex,
        destinationIndex,
        durationSec: syntheticWalkSeconds(a, b),
        distanceMeters: Math.round(syntheticWalkMeters(a, b)),
      };
    }),
  );
  return Promise.resolve(elements);
}
