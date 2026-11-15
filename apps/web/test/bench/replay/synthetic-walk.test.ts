import { describe, expect, it } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { parseDurationMin } from '@aruku/engine/services/access-walk-matrix';
import { haversineKm } from '@aruku/engine/services/hybrid-route-selector';

import {
  syntheticMatrixDelayMs,
  syntheticRouteDelayMs,
  syntheticWalkResponse,
  syntheticWalkSeconds,
} from '../../../src/bench/replay/synthetic-walk';

const tokyo = new GeoPoint(35.681236, 139.767125);
const kanda = new GeoPoint(35.69169, 139.770883);
const proxy = 'https://proxy.invalid';

describe('syntheticWalkSeconds', () => {
  it('直線距離の1.25倍を分速80mで歩いた秒数を、秒へ丸める', () => {
    const meters = haversineKm(tokyo, kanda) * 1000;
    expect(syntheticWalkSeconds(tokyo, kanda)).toBe(Math.round(((meters * 1.25) / 80) * 60));
  });

  it('同じ地点なら0秒', () => {
    expect(syntheticWalkSeconds(tokyo, tokyo)).toBe(0);
  });
});

describe('syntheticWalkResponse', () => {
  it('マトリクスは origins × destinations の全要素を、Routes API と同じ形で返す', () => {
    const url = new URL(`${proxy}/googleWalkMatrixProxy`);
    url.searchParams.set('origins', '35.681236,139.767125;35.69169,139.770883');
    url.searchParams.set('destinations', '35.69169,139.770883');

    const res = syntheticWalkResponse(url);

    expect(res?.delayMs).toBe(syntheticMatrixDelayMs);
    const rows = JSON.parse(res!.body) as Record<string, unknown>[];
    expect(rows).toEqual([
      { originIndex: 0, destinationIndex: 0, duration: `${syntheticWalkSeconds(tokyo, kanda)}s` },
      { originIndex: 1, destinationIndex: 0, duration: '0s' },
    ]);
    expect(parseDurationMin(rows[0].duration)).not.toBeNull();
  });

  it('単発の徒歩は routes[0] に所要と距離（直線の1.25倍）を載せる', () => {
    const url = new URL(`${proxy}/googleWalkProxy`);
    url.searchParams.set('start', '35.681236,139.767125');
    url.searchParams.set('goal', '35.69169,139.770883');

    const res = syntheticWalkResponse(url);

    expect(res?.delayMs).toBe(syntheticRouteDelayMs);
    expect(JSON.parse(res!.body)).toEqual({
      routes: [
        {
          duration: `${syntheticWalkSeconds(tokyo, kanda)}s`,
          distanceMeters: Math.round(haversineKm(tokyo, kanda) * 1000 * 1.25),
        },
      ],
    });
  });

  it('徒歩プロキシ以外の経路は扱わない', () => {
    expect(syntheticWalkResponse(new URL(`${proxy}/exactWalkMax`))).toBeNull();
  });
});
