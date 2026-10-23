import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { SegmentType } from '../../src/models/route-plan';
import {
  exactWalkCandidates,
  timetableSources,
} from '../../src/services/exact-walk-candidates';
import { haversineKm } from '../../src/services/hybrid-route-selector';
import { dateTime } from '../../src/time';
import { inTimeZone } from '../support/time-zone';

const origin = new GeoPoint(35.56, 139.71);
const goal = new GeoPoint(35.71, 139.77);
const ends = { origin, goal, from: '蒲田', to: '上野公園' };

const candidate = (patch: Record<string, unknown> = {}) => ({
  board: { name: '大崎', lat: 35.6197, lng: 139.7283 },
  alight: { name: '神田', lat: 35.6918, lng: 139.7709 },
  route: '山手線',
  headsign: '池袋・上野方面',
  boardAt: '2026-06-27T10:42:00+09:00',
  alightAt: '2026-06-27T11:00:30+09:00',
  stops: [
    { lat: 35.6197, lng: 139.7283 },
    { lat: 35.6284, lng: 139.7387 },
    { lat: 35.6918, lng: 139.7709 },
  ],
  accessWalk: { durationSec: 2529, distanceMeters: 3400 },
  egressWalk: { durationSec: 1470, distanceMeters: 2100 },
  ...patch,
});

describe('exactWalkCandidates (#460)', () => {
  it('候補を 徒歩→電車（実発着時刻つき）→徒歩 の RouteCandidate にする', () => {
    const [c] = exactWalkCandidates({ candidates: [candidate()] }, ends);

    expect(c.from).toEqual('蒲田');
    expect(c.to).toEqual('上野公園');
    expect(c.segments.map((s) => s.type)).toEqual([
      SegmentType.walk,
      SegmentType.train,
      SegmentType.walk,
    ]);

    const [access, ride, egress] = c.segments;
    expect(access.fromName).toEqual('蒲田');
    expect(access.toName).toEqual('大崎');
    expect(access.minutes).toEqual(42); // 2529s = 42.15分
    expect(access.km).toEqual(3.4);
    expect(access.polyline).toEqual([origin, new GeoPoint(35.6197, 139.7283)]);

    expect(ride.fromName).toEqual('大崎');
    expect(ride.toName).toEqual('神田');
    expect(ride.line).toEqual('山手線');
    expect(ride.depTime).toEqual(dateTime(2026, 6, 27, 10, 42));
    expect(ride.arrTime).toEqual(dateTime(2026, 6, 27, 11, 0, 30));
    expect(ride.minutes).toEqual(18);
    expect(ride.stops).toEqual(2);
    expect(ride.polyline).toEqual([
      new GeoPoint(35.6197, 139.7283),
      new GeoPoint(35.6284, 139.7387),
      new GeoPoint(35.6918, 139.7709),
    ]);
    expect(ride.km).toBeCloseTo(
      haversineKm(ride.polyline[0], ride.polyline[1]) +
        haversineKm(ride.polyline[1], ride.polyline[2]),
    );

    expect(egress.fromName).toEqual('神田');
    expect(egress.toName).toEqual('上野公園');
    expect(egress.minutes).toEqual(25); // 1470s = 24.5分
    expect(egress.polyline).toEqual([new GeoPoint(35.6918, 139.7709), goal]);
  });

  it('JST 以外の端末でも、発着時刻を JST の壁時計を表す naive な Date にする（§4 #121）', async () => {
    // 出発アンカー（departureAt）は naive なので、実際の時刻のまま持つと UTC の端末では
    // 9時間ずれて、乗れない便が乗れるように見える。
    await inTimeZone('UTC', () => {
      const [c] = exactWalkCandidates({ candidates: [candidate()] }, ends);
      expect(c.segments[1].depTime).toEqual(dateTime(2026, 6, 27, 10, 42));
      expect(c.segments[1].arrTime).toEqual(dateTime(2026, 6, 27, 11, 0, 30));
    });
  });

  it('時差の無い発着時刻は読み方が端末で変わるので捨てる', () => {
    const cs = exactWalkCandidates(
      { candidates: [candidate({ boardAt: '2026-06-27T10:42:00' })] },
      ends,
    );
    expect(cs).toEqual([]);
  });

  it('0分の徒歩区間は持たない', () => {
    const [c] = exactWalkCandidates(
      {
        candidates: [
          candidate({ accessWalk: { durationSec: 20, distanceMeters: 15 } }),
        ],
      },
      ends,
    );
    expect(c.segments.map((s) => s.type)).toEqual([
      SegmentType.train,
      SegmentType.walk,
    ]);
  });

  it('路線記号コードは guidance の路線名と同じく和名へ写す', () => {
    const [c] = exactWalkCandidates({ candidates: [candidate({ route: 'KO' })] }, ends);
    expect(c.segments[1].line).toEqual('京王線');
  });

  it('路線名が空なら line は null', () => {
    const [c] = exactWalkCandidates({ candidates: [candidate({ route: '' })] }, ends);
    expect(c.segments[1].line).toBeNull();
  });

  it('形の崩れた候補だけを捨て、残りは返す', () => {
    const cs = exactWalkCandidates(
      {
        candidates: [
          candidate({ boardAt: 'not a time' }),
          candidate({ stops: [{ lat: 35.6, lng: 139.7 }] }),
          candidate({ accessWalk: null }),
          candidate({ board: { name: '大崎' } }),
          candidate({ alightAt: '2026-06-27T10:00:00+09:00' }), // 降車が乗車より前
          candidate(),
        ],
      },
      ends,
    );
    expect(cs.length).toEqual(1);
  });

  it('candidates が配列でなければ空', () => {
    expect(exactWalkCandidates({}, ends)).toEqual([]);
    expect(exactWalkCandidates({ candidates: 'x' }, ends)).toEqual([]);
  });
});

describe('timetableSources (#461)', () => {
  it('feeds をフィードごとの取得日時にする', () => {
    expect(
      timetableSources({
        feeds: [
          { id: 'Toei', fetchedAt: '2026-06-27T04:23:10.000Z' },
          { id: 'JR-East', fetchedAt: '2026-06-26T19:23:05+00:00' },
        ],
      }),
    ).toEqual([
      { feedId: 'Toei', fetchedAt: new Date(Date.UTC(2026, 5, 27, 4, 23, 10)) },
      { feedId: 'JR-East', fetchedAt: new Date(Date.UTC(2026, 5, 26, 19, 23, 5)) },
    ]);
  });

  it('形の崩れたフィードだけを捨て、残りは返す', () => {
    const sources = timetableSources({
      feeds: [
        { id: 'Toei' },
        { id: 3, fetchedAt: '2026-06-27T04:23:10.000Z' },
        { id: 'Keio', fetchedAt: 'not a time' },
        { id: 'Tobu', fetchedAt: '2026-06-27T04:23:10' }, // 時差なし
        'Sotetsu',
        { id: 'MIR', fetchedAt: '2026-06-27T04:23:10.000Z' },
      ],
    });
    expect(sources.map((s) => s.feedId)).toEqual(['MIR']);
  });

  it('feeds が配列でなければ空', () => {
    expect(timetableSources({})).toEqual([]);
    expect(timetableSources({ feeds: 'x' })).toEqual([]);
  });
});
