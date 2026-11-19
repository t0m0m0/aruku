import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { isRecord } from '@aruku/engine/json';

import type { ReplayEntry, ReplayStoreData } from './replay-client';

export function loadStore(path: string): ReplayStoreData {
  if (!existsSync(path)) return {};
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) throw new Error(`malformed replay store: ${path}`);
  const store: ReplayStoreData = {};
  for (const [href, entry] of Object.entries(raw)) {
    if (!isReplayEntry(entry)) throw new Error(`malformed replay store: ${path}`);
    store[href] = entry;
  }
  return store;
}

function isReplayEntry(raw: unknown): raw is ReplayEntry {
  return (
    isRecord(raw) &&
    typeof raw['status'] === 'number' &&
    typeof raw['body'] === 'string' &&
    typeof raw['ms'] === 'number'
  );
}

export function mergeStores(onDisk: ReplayStoreData, mine: ReplayStoreData): ReplayStoreData {
  return { ...onDisk, ...mine };
}

export function saveStore(path: string, mine: ReplayStoreData): void {
  const merged = mergeStores(loadStore(path), mine);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged));
  renameSync(tmp, path);
}
