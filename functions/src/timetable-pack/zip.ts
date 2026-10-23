import { strFromU8, unzipSync } from "fflate";

import { GTFS_FILE_NAMES, type GtfsFileName, type GtfsFiles } from "./pack";

const wanted = new Set<string>(GTFS_FILE_NAMES);
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** GTFS の zip から、パックに使うファイルだけを取り出す。 */
export function readGtfsZip(bytes: Uint8Array): GtfsFiles {
  let entries: Record<string, Uint8Array>;
  try {
    // 使わないファイル（fare_rules.txt など）は展開しない。
    entries = unzipSync(bytes, { filter: (f) => wanted.has(baseName(f.name)) });
  } catch (e) {
    throw new Error(`GTFS の zip を展開できない: ${(e as Error).message}`);
  }
  const files: GtfsFiles = {};
  for (const [path, data] of Object.entries(entries)) {
    files[baseName(path) as GtfsFileName] = strFromU8(data);
  }
  return files;
}
