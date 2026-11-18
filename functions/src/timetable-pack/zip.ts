import { strFromU8, unzipSync } from 'fflate';

import { GTFS_FILE_NAMES, type GtfsFileName, type GtfsFiles } from './pack';

const isGtfsFileName = (name: string): name is GtfsFileName =>
  GTFS_FILE_NAMES.some((wanted) => wanted === name);
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export function readGtfsZip(bytes: Uint8Array): GtfsFiles {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (f) => isGtfsFileName(baseName(f.name)) });
  } catch (e) {
    throw new Error(`GTFS の zip を展開できない: ${e instanceof Error ? e.message : String(e)}`);
  }
  const files: GtfsFiles = {};
  for (const [path, data] of Object.entries(entries)) {
    const name = baseName(path);
    if (isGtfsFileName(name)) files[name] = strFromU8(data);
  }
  const missing: string[] = REQUIRED.filter((name) => files[name] === undefined);
  if (files['calendar.txt'] === undefined && files['calendar_dates.txt'] === undefined) {
    missing.push('calendar.txt か calendar_dates.txt');
  }
  if (missing.length > 0) throw new Error(`GTFS の zip に無い: ${missing.join(', ')}`);
  return files;
}

const REQUIRED: readonly GtfsFileName[] = [
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
];
