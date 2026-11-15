import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReplayEntry } from '../../../src/bench/replay/replay-client';
import { loadStore, mergeStores, saveStore } from '../../../src/bench/replay/replay-store';

const e = (ms: number): ReplayEntry => ({ status: 200, body: '', ms });

describe('mergeStores', () => {
  it('ディスクにだけある録画を残す——並列の別プロセスが足した分を消さない', () => {
    expect(mergeStores({ a: e(1) }, { b: e(2) })).toEqual({ a: e(1), b: e(2) });
  });

  it('同じ照会は手元の録画を採る（録画モードで取り直した応答の方が新しい）', () => {
    expect(mergeStores({ a: e(1) }, { a: e(2) })).toEqual({ a: e(2) });
  });
});

describe('loadStore / saveStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'replay-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ファイルが無ければ空の録画から始める', () => {
    expect(loadStore(join(dir, 'missing.json'))).toEqual({});
  });

  it('保存の直前にディスクを読み直して合流させる', () => {
    const path = join(dir, 'rec.json');
    const mine = loadStore(path);
    mine.mine = e(1);
    writeFileSync(path, JSON.stringify({ other: e(2) }));

    saveStore(path, mine);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ other: e(2), mine: e(1) });
  });
});
