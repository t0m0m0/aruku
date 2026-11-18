import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { haversineKm } from '../../src/services/hybrid-route-selector';
import { correctStationCoord } from '../../src/services/station-coord-corrections';
import { stationCoordTable } from '../../src/services/station-coord-table';

describe('correctStationCoord（#515）', () => {
  it('Transit API の宇都宮線の久喜（約1km 西南西にずれた座標）を実際の駅の座標へ置き換える', () => {
    const corrected = correctStationCoord(new GeoPoint(36.06301, 139.66734));
    expect(corrected).not.toBeNull();
    expect(haversineKm(corrected!, new GeoPoint(36.06555, 139.67761))).toBeLessThan(0.05);
  });

  it('表に無い座標は補正しない（null）', () => {
    expect(correctStationCoord(new GeoPoint(36.06555, 139.67761))).toBeNull();
    expect(correctStationCoord(new GeoPoint(35.681236, 139.767125))).toBeNull();
  });

  it('小数5桁で一致すれば補正する（上流の桁数の揺れを吸収する）', () => {
    expect(correctStationCoord(new GeoPoint(36.063011, 139.667342))).not.toBeNull();
  });

  it('補正した点は heading を引き継がない新しい点で、元の点は変えない', () => {
    const raw = new GeoPoint(36.06301, 139.66734);
    const corrected = correctStationCoord(raw)!;
    expect(corrected.heading).toBeNull();
    expect(raw.lat).toBe(36.06301);
  });
});

describe('stationCoordTable', () => {
  it('どの行も、ずれが補正の対象とする幅（500m 超・5km 以下）に収まり、offsetM と一致する', () => {
    for (const row of stationCoordTable) {
      const m =
        haversineKm(new GeoPoint(row.from[0], row.from[1]), new GeoPoint(row.to[0], row.to[1])) *
        1000;
      expect(m, row.station).toBeGreaterThan(500);
      expect(m, row.station).toBeLessThanOrEqual(5000);
      expect(Math.abs(m - row.offsetM), row.station).toBeLessThan(1);
    }
  });

  it('同じずれた座標を2度載せない（どちらの補正先を採るかが曖昧になる）', () => {
    const keys = stationCoordTable.map((r) => r.from.join(','));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
