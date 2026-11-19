import { describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import type { PlacePrediction } from '../../src/places/place-prediction';
import { PlacesException, type PlacesService } from '../../src/places/places-service';
import { resolvePlacePrediction } from '../../src/places/resolve-prediction';

const prediction: PlacePrediction = {
  placeId: 'p1',
  name: 'ハチ公前',
  address: '東京都渋谷区',
  distanceMeters: 120,
};

function service(fetchLatLng: PlacesService['fetchLatLng']): PlacesService {
  return {
    autocomplete: async () => [],
    fetchLatLng,
    close() {},
  };
}

describe('候補の確定', () => {
  it('座標を引いて地点にする', async () => {
    const resolved = await resolvePlacePrediction(
      service(async () => new GeoPoint(35.6, 139.7)),
      prediction,
    );

    expect(resolved).toEqual({
      name: 'ハチ公前',
      placeId: 'p1',
      latLng: new GeoPoint(35.6, 139.7),
      address: '東京都渋谷区',
      usedAt: null,
    });
  });

  it('引く相手は候補の placeId', async () => {
    const fetchLatLng = vi.fn(async () => new GeoPoint(35.6, 139.7));

    await resolvePlacePrediction(service(fetchLatLng), prediction);

    expect(fetchLatLng).toHaveBeenCalledWith('p1');
  });

  it('座標が取れない候補は確定させない', async () => {
    const resolved = await resolvePlacePrediction(
      service(async () => null),
      prediction,
    );

    expect(resolved).toBeNull();
  });

  it('PlacesException も座標なし扱いにする', async () => {
    const resolved = await resolvePlacePrediction(
      service(async () => {
        throw new PlacesException('REQUEST_DENIED');
      }),
      prediction,
    );

    expect(resolved).toBeNull();
  });

  it('PlacesException 以外の例外も座標なし扱いにする', async () => {
    const resolved = await resolvePlacePrediction(
      service(async () => {
        throw new TypeError('Failed to fetch');
      }),
      prediction,
    );

    expect(resolved).toBeNull();
  });
});
