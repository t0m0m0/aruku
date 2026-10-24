import { describe, expect, it } from 'vitest';

import { dateTime } from '@aruku/engine/time';

import type { BenchRecord, BenchRide } from '../../src/bench/bench-record';
import {
  parseWallClock,
  ridesToVerify,
  runVerify,
  type BoardDeparture,
  type BoardStation,
  type VerifyResult,
} from '../../src/bench/ab-verify';

const ride: BenchRide = {
  type: 'train',
  line: 'JR山手線',
  from: '大崎',
  to: '神田',
  fromLat: 35.6197,
  fromLng: 139.7283,
  toLat: 35.6918,
  toLng: 139.7709,
  dep: '2026-10-27T12:40',
  arr: '2026-10-27T13:00',
};

describe('ridesToVerify: 照合する経路を選ぶ', () => {
  const rec = (pair: string, exactWon: number, rides: BenchRide[] = [ride]): BenchRecord => ({
    pair,
    date: '2026-10-27',
    slot: '12:00',
    ratio: 1.5,
    standardMin: 40,
    budgetMin: 60,
    metrics: { exactWon },
    plan: { totalMin: 55, budgetMin: 60, walkMinutes: 40, withinBudget: true, missed: false, rides },
    error: null,
  });

  it('厳密走査が勝った1回乗車の経路だけを、上限まで OD が散るように選ぶ', () => {
    const picked = ridesToVerify(
      [rec('p1', 1), rec('p1', 1), rec('p2', 0), rec('p3', 1), rec('p4', 1, [ride, ride])],
      2,
    );
    expect(picked.map((p) => p.record.pair)).toEqual(['p1', 'p3']);
  });

  it('到着時刻の無い便は選ばない（降車駅で同じ便を確かめられない）', () => {
    const noArrival = { ...ride, arr: null };
    expect(ridesToVerify([rec('p1', 1, [noArrival]), rec('p2', 1)], 10).map((p) => p.record.pair)).toEqual(['p2']);
  });
});

describe('parseWallClock', () => {
  it('JSONL の壁時計を naive な Date に戻す', () => {
    expect(parseWallClock('2026-10-27T12:40')).toEqual(dateTime(2026, 10, 27, 12, 40));
  });
});

describe('runVerify: 乗車駅の発車表で便の実在を確かめる', () => {
  const record: BenchRecord = {
    pair: 'p1',
    date: '2026-10-27',
    slot: '12:00',
    ratio: 1.5,
    standardMin: 40,
    budgetMin: 60,
    metrics: { exactWon: 1 },
    plan: { totalMin: 55, budgetMin: 60, walkMinutes: 40, withinBudget: true, missed: false, rides: [ride] },
    error: null,
  };

  const station = (id: string, name: string, lat: number, lng: number, feedId = 'yamanote'): BoardStation => ({
    id: `${feedId}:${id}`,
    feedId,
    name,
    lat,
    lng,
  });
  const osaki = station('Osaki', '大崎', 35.6197, 139.7283);
  const kanda = station('Kanda', '神田', 35.6918, 139.7709);
  const departure = (tripId: string, h: number, m: number, headsign = '東京・上野方面'): BoardDeparture => ({
    tripId,
    routeName: '山手線',
    headsign,
    departureSecs: h * 3600 + m * 60,
  });

  async function verify(
    stations: Record<string, BoardStation[]>,
    boards: Record<string, BoardDeparture[] | null>,
  ): Promise<{ results: VerifyResult[]; calls: string[] }> {
    const calls: string[] = [];
    const results: VerifyResult[] = [];
    await runVerify([{ record, ride }], {
      findStations: async (name) => {
        calls.push(`stations ${name}`);
        return stations[name] ?? [];
      },
      fetchDepartures: async (id, date, time) => {
        calls.push(`departures ${id} ${date} ${time}`);
        return id in boards ? boards[id] : [];
      },
      write: (r) => results.push(r),
      shouldStop: () => false,
    });
    return { results, calls };
  }

  it('乗車駅を同じ分に発つ便が、降車駅も到着の ±2分以内に発つなら同じ便とする', async () => {
    const { results, calls } = await verify(
      { 大崎: [osaki], 神田: [kanda] },
      {
        [osaki.id]: [departure('t-before', 12, 39), departure('t1', 12, 40), departure('t-later', 12, 50)],
        [kanda.id]: [departure('t-other', 13, 0), departure('t1', 13, 1)],
      },
    );
    expect(results[0]).toMatchObject({ verdict: 'sameTrip', matchedLine: '山手線 東京・上野方面', error: null });
    // 乗車駅は発車の少し前から引き、前後の数分の便だけを seen に残す（ずれていたとき人が見比べられる）。
    expect(calls).toContain(`departures ${osaki.id} 20261027 12:38`);
    expect(calls).toContain(`departures ${kanda.id} 20261027 12:58`);
    expect(results[0].seen).toEqual(['12:39 山手線 東京・上野方面', '12:40 山手線 東京・上野方面']);
  });

  it('照会の座標から乗り場が遠くても、発車表に在れば在るとする（経路検索の徒歩に左右されない）', async () => {
    // 三鷹の中央線快速は、Transit API では各停の乗り場から 372m 離れている（#462 の照合で偽陰性になった）。
    const farPlatform = station('OsakiRapid', '大崎', 35.6197 - 0.0034, 139.7283);
    const { results } = await verify(
      { 大崎: [farPlatform], 神田: [kanda] },
      { [farPlatform.id]: [departure('t1', 12, 40)], [kanda.id]: [departure('t1', 13, 0)] },
    );
    expect(results[0].verdict).toEqual('sameTrip');
  });

  it('降車駅の発車表に同じ便が無ければ、乗車駅の発車だけが一致したとする（終点の便は降車駅の発車表に載らない）', async () => {
    const { results } = await verify(
      { 大崎: [osaki], 神田: [kanda] },
      { [osaki.id]: [departure('t1', 12, 40)], [kanda.id]: [departure('t-other', 13, 0)] },
    );
    expect(results[0]).toMatchObject({ verdict: 'departureOnly', matchedLine: '山手線 東京・上野方面' });
  });

  it('降車駅で同じ便が到着から3分以上ずれていれば、同じ便としない', async () => {
    const { results } = await verify(
      { 大崎: [osaki], 神田: [kanda] },
      { [osaki.id]: [departure('t1', 12, 40)], [kanda.id]: [departure('t1', 13, 3)] },
    );
    expect(results[0].verdict).toEqual('departureOnly');
  });

  it('同じ分に発つ便が無ければ無いとする（近い便を拾って本物と取り違えない）', async () => {
    const { results, calls } = await verify(
      { 大崎: [osaki], 神田: [kanda] },
      { [osaki.id]: [departure('t1', 12, 41)] },
    );
    expect(results[0]).toMatchObject({ verdict: 'missing', matchedLine: null, seen: ['12:41 山手線 東京・上野方面'] });
    expect(calls.some((c) => c.startsWith(`departures ${kanda.id}`))).toBe(false);
  });

  it('降車駅は乗車駅と同じフィードの駅を見る（別の事業者の駅の tripId と突き合わせない）', async () => {
    const otherFeedKanda = station('Kanda', '神田', 35.6918, 139.7709, 'ginza');
    const { results } = await verify(
      { 大崎: [osaki], 神田: [otherFeedKanda] },
      { [osaki.id]: [departure('t1', 12, 40)], [otherFeedKanda.id]: [departure('t1', 13, 0)] },
    );
    expect(results[0].verdict).toEqual('departureOnly');
  });

  it('名前が違う駅・500m より遠い同名の駅は乗車駅としない', async () => {
    const sanchome = station('OsakiSanchome', '大崎三丁目', 35.6197, 139.7283);
    const farNamesake = station('OsakiFar', '大崎', 35.7, 139.7283);
    const { results, calls } = await verify(
      { 大崎: [sanchome, farNamesake], 神田: [kanda] },
      { [sanchome.id]: [departure('t1', 12, 40)], [farNamesake.id]: [departure('t1', 12, 40)] },
    );
    expect(results[0].verdict).toEqual('noBoard');
    expect(calls.filter((c) => c.startsWith('departures'))).toEqual([]);
  });

  it('駅名の「駅」・括弧書き・ローマ字の併記は揃えて比べる', async () => {
    const romanized = station('Osaki', '大崎 Ōsaki', 35.6197, 139.7283);
    const { results } = await verify(
      { 大崎: [romanized], 神田: [kanda] },
      { [romanized.id]: [departure('t1', 12, 40)], [kanda.id]: [departure('t1', 13, 0)] },
    );
    expect(results[0].verdict).toEqual('sameTrip');
  });

  it('発車表を出さない駅（ODPT 由来）しか無ければ、無いではなく発車表なしとする', async () => {
    const { results } = await verify({ 大崎: [osaki], 神田: [kanda] }, { [osaki.id]: null });
    expect(results[0]).toMatchObject({ verdict: 'noBoard', error: null });
  });

  it('同じ駅に複数のフィードがあれば、同じ便が確かめられるまで次のフィードも見る', async () => {
    const localFeed = station('Osaki', '大崎', 35.6197, 139.7283, 'local');
    const { results } = await verify(
      { 大崎: [localFeed, osaki], 神田: [kanda] },
      { [localFeed.id]: null, [osaki.id]: [departure('t1', 12, 40)], [kanda.id]: [departure('t1', 13, 0)] },
    );
    expect(results[0].verdict).toEqual('sameTrip');
  });

  it('照会が失敗しても理由を書いて次へ進む', async () => {
    const results: VerifyResult[] = [];
    await runVerify([{ record, ride }, { record, ride }], {
      findStations: async () => {
        throw new Error('HTTP 429');
      },
      fetchDepartures: async () => [],
      write: (r) => results.push(r),
      shouldStop: () => false,
    });
    expect(results).toHaveLength(2);
    expect(results[0].verdict).toBeNull();
    expect(results[0].error).toContain('HTTP 429');
  });
});
