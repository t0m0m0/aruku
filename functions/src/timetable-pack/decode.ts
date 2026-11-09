// Storage から読んだ時刻表パック（gzip した JSON）を TimetablePack に戻す（#487）。

import { gunzipSync } from "node:zlib";

import { PACK_FORMAT_VERSION, type TimetablePack } from "./pack";

export type DecodeResult =
  | { status: "success"; pack: TimetablePack; gunzipMs: number; parseMs: number }
  | { status: "failure"; reason: "format"; gunzipMs: number; parseMs: number };

export function decodePack(gzipped: Uint8Array, now: () => number): DecodeResult {
  const start = now();
  let json: string;
  try {
    json = gunzipSync(gzipped).toString("utf8");
  } catch {
    return { status: "failure", reason: "format", gunzipMs: now() - start, parseMs: 0 };
  }
  const parsed = now();
  const gunzipMs = parsed - start;
  let pack: TimetablePack;
  try {
    pack = JSON.parse(json) as TimetablePack;
  } catch {
    return { status: "failure", reason: "format", gunzipMs, parseMs: now() - parsed };
  }
  const parseMs = now() - parsed;
  if (pack.format !== PACK_FORMAT_VERSION) {
    return { status: "failure", reason: "format", gunzipMs, parseMs };
  }
  return { status: "success", pack, gunzipMs, parseMs };
}
