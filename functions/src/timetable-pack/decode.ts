// Storage から読んだ時刻表パック（gzip した JSON）を TimetablePack に戻す（#487）。

import { gunzipSync } from 'node:zlib';

import { isRecord } from '../json';
import { PACK_FORMAT_VERSION, type TimetablePack } from './pack';

export type DecodeResult =
  | { status: 'success'; pack: TimetablePack; gunzipMs: number; parseMs: number }
  | { status: 'failure'; reason: 'format'; gunzipMs: number; parseMs: number };

export function decodePack(gzipped: Uint8Array, now: () => number): DecodeResult {
  const start = now();
  let json: string;
  try {
    json = gunzipSync(gzipped).toString('utf8');
  } catch {
    return { status: 'failure', reason: 'format', gunzipMs: now() - start, parseMs: 0 };
  }
  const parsed = now();
  const gunzipMs = parsed - start;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { status: 'failure', reason: 'format', gunzipMs, parseMs: now() - parsed };
  }
  const parseMs = now() - parsed;
  if (!isTimetablePack(raw)) {
    return { status: 'failure', reason: 'format', gunzipMs, parseMs };
  }
  return { status: 'success', pack: raw, gunzipMs, parseMs };
}

// 要素の中までは確かめない。パックは refreshTimetablePacks が書いたもので、形は format の版が
// 保証する。数十万の便を検査し直すと、要求の途中で読むときの遅延（loadMs）にそのまま乗る。
function isTimetablePack(value: unknown): value is TimetablePack {
  return (
    isRecord(value) &&
    value['format'] === PACK_FORMAT_VERSION &&
    Array.isArray(value['feeds']) &&
    Array.isArray(value['stations']) &&
    Array.isArray(value['stops']) &&
    Array.isArray(value['services']) &&
    Array.isArray(value['trips'])
  );
}
