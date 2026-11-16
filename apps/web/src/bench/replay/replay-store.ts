// 再生ハーネス（#504）の録画ファイルの読み書き。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { ReplayStoreData } from './replay-client';

export function loadStore(path: string): ReplayStoreData {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ReplayStoreData) : {};
}

/// 同じ照会は [mine] を採る。録画モードで取り直した応答の方が新しいため。
export function mergeStores(onDisk: ReplayStoreData, mine: ReplayStoreData): ReplayStoreData {
  return { ...onDisk, ...mine };
}

/// 保存の直前にディスクを読み直して合流させる。読み込んだ時点の写しをそのまま書き戻すと、
/// 同じ録画を並列に再生している別のプロセスが足した照会を消してしまう。
export function saveStore(path: string, mine: ReplayStoreData): void {
  const merged = mergeStores(loadStore(path), mine);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged));
  renameSync(tmp, path);
}
