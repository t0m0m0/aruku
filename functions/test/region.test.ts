import { describe, expect, it } from 'vitest';
import type { HttpsFunction } from 'firebase-functions/v2/https';

import { exactWalkMax, googleWalkMatrixProxy, googleWalkProxy, placesProxy } from '../src/index';

function endpoint(fn: HttpsFunction): { region?: string[]; maxInstances?: number } | undefined {
  return (
    fn as unknown as {
      __endpoint?: { region?: string[]; maxInstances?: number };
    }
  ).__endpoint;
}

const ALL_PROXIES = [
  ['googleWalkProxy', googleWalkProxy],
  ['googleWalkMatrixProxy', googleWalkMatrixProxy],
  ['placesProxy', placesProxy],
  ['exactWalkMax', exactWalkMax],
] as const;

const EXPECTED_MAX_INSTANCES = 10;

describe('deploy region', () => {
  it.each(ALL_PROXIES)('%s は asia-northeast1 にデプロイされる', (_name, fn) => {
    expect(endpoint(fn)?.region).toEqual(['asia-northeast1']);
  });
});

describe('maxInstances 上限', () => {
  it.each(ALL_PROXIES)('%s は maxInstances が設定される', (_name, fn) => {
    expect(endpoint(fn)?.maxInstances).toBe(EXPECTED_MAX_INSTANCES);
  });
});
