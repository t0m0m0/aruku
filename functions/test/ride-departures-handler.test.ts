import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';

import { PACK_FORMAT_VERSION, type TimetablePack } from '../src/timetable-pack/pack';

const { httpsRequestMock, verifyTokenMock, downloadMock, MockAgent, infoSpy } = vi.hoisted(() => ({
  infoSpy: vi.fn(),
  httpsRequestMock: vi.fn(),
  verifyTokenMock: vi.fn(),
  downloadMock: vi.fn<(path: string) => Promise<[Buffer]>>(),
  MockAgent: class MockAgent {
    constructor(readonly options: Record<string, unknown>) {}
  },
}));

vi.mock('https', () => ({
  default: { request: httpsRequestMock, Agent: MockAgent },
  request: httpsRequestMock,
  Agent: MockAgent,
}));

vi.mock('../src/metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/metrics')>()),
  logRideDeparture: infoSpy,
}));

vi.mock('firebase-admin/app-check', () => ({
  getAppCheck: () => ({ verifyToken: verifyTokenMock }),
}));

vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({ file: (path: string) => ({ download: () => downloadMock(path) }) }),
  }),
}));

import {
  resetExactWalkMaxPacks,
  resetRateLimit,
  resetUpstreamCache,
  rideDepartures,
} from '../src/index';

const PACK: TimetablePack = {
  format: PACK_FORMAT_VERSION,
  feeds: [{ id: 'Toei', fetchedAt: '2026-10-22T19:23:00.000Z', version: null }],
  stations: [],
  stops: [
    { name: 'A駅', lat: 35.57, lng: 139.71, feed: 0, station: 0 },
    { name: 'B駅', lat: 35.69, lng: 139.77, feed: 0, station: 1 },
  ],
  services: [{ dates: [20261023] }],
  trips: [
    {
      feed: 0,
      service: 0,
      route: 'テスト線',
      headsign: 'B駅行',
      block: null,
      stops: [0, 1],
      arr: [37800, 39000],
      dep: [37800, 39000],
      board: [1, 1],
      alight: [1, 1],
    },
  ],
};

const QUERY = {
  at: '2026-10-23T10:00:00+09:00',
  board: '35.57,139.71',
  alight: '35.69,139.77',
  boardName: 'A駅',
  alightName: 'B駅',
  line: 'テスト線',
};

function storageHas(pack: TimetablePack | null): void {
  downloadMock.mockImplementation(async (path: string) => {
    if (pack === null || !path.startsWith('permanent/')) {
      throw Object.assign(new Error('No such object'), { code: 404 });
    }
    return [gzipSync(JSON.stringify(pack))];
  });
}

interface CapturedRes {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  status(code: number): CapturedRes;
  json(b: unknown): CapturedRes;
  send(b?: unknown): CapturedRes;
  set(name: string, value?: string): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    set(name, value) {
      if (value !== undefined) this.headers[name] = value;
      return this;
    },
  };
}

async function invoke(
  query: Record<string, string>,
  opts: { token?: string } = {},
): Promise<CapturedRes> {
  const req = {
    method: 'GET',
    query,
    headers: {},
    header: (name: string) =>
      name.toLowerCase() === 'x-firebase-appcheck' ? opts.token : undefined,
    ip: '127.0.0.1',
  };
  const res = makeRes();
  await rideDepartures(req as unknown as Request, res as unknown as Response);
  return res;
}

describe('rideDepartures', () => {
  beforeEach(() => {
    resetRateLimit();
    resetUpstreamCache();
    resetExactWalkMaxPacks();
    httpsRequestMock.mockReset();
    verifyTokenMock.mockReset();
    downloadMock.mockReset();
    infoSpy.mockReset();
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T00:30:00Z'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('App Check のトークンが無ければ 401 を返し、パックを読まない', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    storageHas(PACK);

    const res = await invoke(QUERY);

    expect(res.statusCode).toBe(401);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('トークンを使い捨てとして検証する（時刻表を連続して引き出させない）', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    verifyTokenMock.mockResolvedValue({ alreadyConsumed: true });
    storageHas(PACK);

    const res = await invoke(QUERY, { token: 't' });

    expect(verifyTokenMock).toHaveBeenCalledWith('t', { consume: true });
    expect(res.statusCode).toBe(401);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('レート制限の鍵を Secret Manager から受け取る（無いと本番で制限が効かない）', () => {
    const endpoint = (
      rideDepartures as unknown as {
        __endpoint?: { secretEnvironmentVariables?: { key: string }[] };
      }
    ).__endpoint;
    expect(endpoint?.secretEnvironmentVariables?.map((v) => v.key)).toContain(
      'RATE_LIMIT_HMAC_KEY',
    );
  });

  it.each([
    ['board が無い', { ...QUERY, board: '' }],
    ['at に時差が無い', { ...QUERY, at: '2026-10-23T10:00:00' }],
    ['line が無い', { ...QUERY, line: '' }],
  ])('%s入力は 400 を返し、パックを読まない', async (_name, query) => {
    storageHas(PACK);

    const res = await invoke(query);

    expect(res.statusCode).toBe(400);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('乗る 1 本とフィードの取得日時だけを返し、時刻表そのものも上流も返さない', async () => {
    storageHas(PACK);

    const res = await invoke(QUERY);

    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual({
      ride: {
        route: 'テスト線',
        headsign: 'B駅行',
        from: 'A駅',
        to: 'B駅',
        boardAt: '2026-10-23T10:30:00+09:00',
        alightAt: '2026-10-23T10:50:00+09:00',
      },
      feeds: [{ id: 'Toei', fetchedAt: '2026-10-22T19:23:00.000Z' }],
    });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it('要求ごとに結果をログに出し、座標・時刻・駅名の値は出さない (#553)', async () => {
    storageHas(PACK);

    await invoke(QUERY);
    await invoke({ ...QUERY, boardName: '' });

    expect(infoSpy.mock.calls).toEqual([
      [{ outcome: 'ride', line: 'テスト線', boardNamed: true, alightNamed: true }],
      [{ outcome: 'ride', line: 'テスト線', boardNamed: false, alightNamed: true }],
    ]);
  });

  it('入力が読めないときとパックが無いときは、結果のログを出さない (#553)', async () => {
    storageHas(null);

    await invoke({ ...QUERY, line: '' });
    await invoke(QUERY);

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('読めるパックが無ければ 503 を返す', async () => {
    storageHas(null);

    const res = await invoke(QUERY);

    expect(res.statusCode).toBe(503);
  });
});
