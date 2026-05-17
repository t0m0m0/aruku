import { describe, expect, it } from "vitest";

import { buildRoutesRequestBody } from "../src/routes-request";

describe("buildRoutesRequestBody", () => {
  it("座標文字列を latLng エンドポイントへ変換する", () => {
    const body = buildRoutesRequestBody({
      origin: "35.0,139.0",
      destination: "35.1,139.1",
      rawMode: "walking",
      alternatives: false,
    });

    expect(body.origin).toEqual({
      location: { latLng: { latitude: 35.0, longitude: 139.0 } },
    });
    expect(body.destination).toEqual({
      location: { latLng: { latitude: 35.1, longitude: 139.1 } },
    });
    expect(body.travelMode).toBe("WALK");
    expect(body.languageCode).toBe("ja");
  });

  it("座標でない文字列は address エンドポイントへ変換する", () => {
    const body = buildRoutesRequestBody({
      origin: "東京駅",
      destination: "35.1,139.1",
      rawMode: "walking",
      alternatives: false,
    });

    expect(body.origin).toEqual({ address: "東京駅" });
  });

  it("alternatives を computeAlternativeRoutes へ反映する", () => {
    const t = buildRoutesRequestBody({
      origin: "35.0,139.0",
      destination: "35.1,139.1",
      rawMode: "transit",
      alternatives: true,
    });
    expect(t.computeAlternativeRoutes).toBe(true);

    const f = buildRoutesRequestBody({
      origin: "35.0,139.0",
      destination: "35.1,139.1",
      rawMode: "walking",
      alternatives: false,
    });
    expect(f.computeAlternativeRoutes).toBe(false);
  });

  it("TRANSIT では transitPreferences.allowedTravelModes を付与する", () => {
    const body = buildRoutesRequestBody({
      origin: "35.0,139.0",
      destination: "35.5,139.5",
      rawMode: "transit",
      alternatives: true,
    });

    expect(body.travelMode).toBe("TRANSIT");
    expect(body.transitPreferences).toEqual({
      allowedTravelModes: ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"],
    });
  });

  it("TRANSIT 以外では transitPreferences を付与しない", () => {
    for (const rawMode of ["walking", "driving", "bicycling"]) {
      const body = buildRoutesRequestBody({
        origin: "35.0,139.0",
        destination: "35.1,139.1",
        rawMode,
        alternatives: false,
      });
      expect("transitPreferences" in body).toBe(false);
    }
  });

  it("departureTime（epoch 秒）を ISO 8601 へ変換する", () => {
    const body = buildRoutesRequestBody({
      origin: "35.0,139.0",
      destination: "35.5,139.5",
      rawMode: "transit",
      alternatives: true,
      departureTime: "1700000000",
    });

    expect(body.departureTime).toBe(
      new Date(1700000000 * 1000).toISOString()
    );
  });

  it("departureTime 未指定なら departureTime キーを付与しない", () => {
    const body = buildRoutesRequestBody({
      origin: "35.0,139.0",
      destination: "35.1,139.1",
      rawMode: "walking",
      alternatives: false,
    });

    expect("departureTime" in body).toBe(false);
  });
});
