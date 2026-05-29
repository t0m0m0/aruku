import { describe, expect, it } from "vitest";

import { buildRoutesWalkBody } from "../src/index";

describe("buildRoutesWalkBody", () => {
  it("origin/destination を latLng で、travelMode を WALK で含める", () => {
    const body = JSON.parse(
      buildRoutesWalkBody(
        { latitude: 35.7, longitude: 139.75 },
        { latitude: 35.681, longitude: 139.767 }
      )
    );
    expect(body.origin.location.latLng).toEqual({
      latitude: 35.7,
      longitude: 139.75,
    });
    expect(body.destination.location.latLng).toEqual({
      latitude: 35.681,
      longitude: 139.767,
    });
    expect(body.travelMode).toBe("WALK");
  });
});
