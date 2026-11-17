import { describe, expect, it } from 'vitest';

import { buildRoutesWalkBody } from '../src/index';

describe('buildRoutesWalkBody', () => {
  it('origin/destination を latLng で、travelMode を WALK で含める', () => {
    const body: unknown = JSON.parse(
      buildRoutesWalkBody(
        { latitude: 35.7, longitude: 139.75 },
        { latitude: 35.681, longitude: 139.767 },
      ),
    );
    expect(body).toHaveProperty(['origin', 'location', 'latLng'], {
      latitude: 35.7,
      longitude: 139.75,
    });
    expect(body).toHaveProperty(['destination', 'location', 'latLng'], {
      latitude: 35.681,
      longitude: 139.767,
    });
    expect(body).toHaveProperty('travelMode', 'WALK');
  });
});
