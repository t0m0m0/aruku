import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import {
  findExactWalkMax,
  parseExactWalkMaxQuery,
  type MatrixElement,
} from '../../../../../functions/src/exact-walk-max';
import {
  findRideDepartures,
  parseRideDeparturesQuery,
} from '../../../../../functions/src/ride-departures';
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
  readonly now: () => Date;
}

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

export function localRideDepartures(
  init: LocalExactWalkMaxInit,
): (url: URL) => Promise<ExactReplayResponse> {
  const day = createScanDaySource({
    read: packDirReader(init.packDir),
    log: () => undefined,
    now: () => Date.now(),
  });
  return async (url) => {
    const parsed = parseRideDeparturesQuery(Object.fromEntries(url.searchParams), init.now());
    if ('error' in parsed) return { status: 400, body: JSON.stringify({ error: parsed.error }) };
    const body = await findRideDepartures(parsed, { day });
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
