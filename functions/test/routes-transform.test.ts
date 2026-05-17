import { describe, expect, it } from "vitest";

import {
  parseDurationSeconds,
  toLegacyDirections,
  toLegacyTravelMode,
} from "../src/routes-transform";

// テスト用エンコード済みポリライン（任意の文字列）
const _poly = "_p~iF~ps|U";

function walkStep(distanceMeters: number, durationSec: number) {
  return {
    travelMode: "WALK",
    distanceMeters,
    staticDuration: `${durationSec}s`,
    polyline: { encodedPolyline: _poly },
  };
}

function transitStep(
  distanceMeters: number,
  durationSec: number,
  opts: { dep: string; arr: string; line: string; stops: number }
) {
  return {
    travelMode: "TRANSIT",
    distanceMeters,
    staticDuration: `${durationSec}s`,
    polyline: { encodedPolyline: _poly },
    transitDetails: {
      stopDetails: {
        departureStop: { name: opts.dep },
        arrivalStop: { name: opts.arr },
      },
      transitLine: { name: opts.line },
      stopCount: opts.stops,
    },
  };
}

function route(steps: unknown[], startAddress = "出発地", endAddress = "目的地") {
  return { legs: [{ startAddress, endAddress, steps }] };
}

function routesResponse(routes: unknown[]) {
  return { routes };
}

// ---------------------------------------------------------------------------

describe("parseDurationSeconds", () => {
  it('"3600s" を 3600 に変換する', () => {
    expect(parseDurationSeconds("3600s")).toBe(3600);
  });

  it('"90s" を 90 に変換する', () => {
    expect(parseDurationSeconds("90s")).toBe(90);
  });

  it('"0s" を 0 に変換する', () => {
    expect(parseDurationSeconds("0s")).toBe(0);
  });

  it('不正な文字列は 0 を返す', () => {
    expect(parseDurationSeconds("abc")).toBe(0);
    expect(parseDurationSeconds("")).toBe(0);
    expect(parseDurationSeconds(null)).toBe(0);
    expect(parseDurationSeconds(undefined)).toBe(0);
  });
});

describe("toLegacyTravelMode", () => {
  it('"WALK" を "WALKING" に変換する', () => {
    expect(toLegacyTravelMode("WALK")).toBe("WALKING");
  });

  it('"TRANSIT" はそのまま "TRANSIT" を返す', () => {
    expect(toLegacyTravelMode("TRANSIT")).toBe("TRANSIT");
  });

  it('"DRIVE" はそのまま "DRIVE" を返す', () => {
    expect(toLegacyTravelMode("DRIVE")).toBe("DRIVE");
  });

  it('不明な値はそのまま返す', () => {
    expect(toLegacyTravelMode("BICYCLE")).toBe("BICYCLE");
  });
});

describe("toLegacyDirections", () => {
  it("徒歩ルートをレガシー形式へ変換する", () => {
    const raw = routesResponse([route([walkStep(5000, 3600)])]);

    const result = toLegacyDirections(raw);

    expect(result.status).toBe("OK");
    expect(result.routes).toHaveLength(1);
    const leg = result.routes[0].legs[0];
    expect(leg.start_address).toBe("出発地");
    expect(leg.end_address).toBe("目的地");
    expect(leg.steps).toHaveLength(1);
    const step = leg.steps[0];
    expect(step.travel_mode).toBe("WALKING");
    expect(step.distance.value).toBe(5000);
    expect(step.duration.value).toBe(3600);
    expect(step.polyline.points).toBe(_poly);
    expect(step.transit_details).toBeUndefined();
  });

  it("transit ルートを transit_details 付きで変換する", () => {
    const raw = routesResponse([
      route([
        walkStep(1000, 600),
        transitStep(4000, 1200, {
          dep: "原宿",
          arr: "渋谷",
          line: "JR山手線",
          stops: 2,
        }),
        walkStep(800, 540),
      ]),
    ]);

    const result = toLegacyDirections(raw);

    expect(result.status).toBe("OK");
    const steps = result.routes[0].legs[0].steps;
    expect(steps).toHaveLength(3);

    // 徒歩ステップ
    expect(steps[0].travel_mode).toBe("WALKING");
    expect(steps[0].transit_details).toBeUndefined();

    // 電車ステップ
    const train = steps[1];
    expect(train.travel_mode).toBe("TRANSIT");
    expect(train.distance.value).toBe(4000);
    expect(train.duration.value).toBe(1200);
    expect(train.transit_details).toBeDefined();
    expect(train.transit_details!.departure_stop.name).toBe("原宿");
    expect(train.transit_details!.arrival_stop.name).toBe("渋谷");
    expect(train.transit_details!.line.name).toBe("JR山手線");
    expect(train.transit_details!.num_stops).toBe(2);
  });

  it("複数ルート（alternatives）をすべて変換する", () => {
    const raw = routesResponse([
      route([walkStep(5000, 3600)]),
      route([
        walkStep(1000, 600),
        transitStep(4000, 1200, {
          dep: "代々木",
          arr: "渋谷",
          line: "JR山手線",
          stops: 1,
        }),
        walkStep(800, 540),
      ]),
    ]);

    const result = toLegacyDirections(raw);

    expect(result.status).toBe("OK");
    expect(result.routes).toHaveLength(2);
    expect(result.routes[0].legs[0].steps).toHaveLength(1);
    expect(result.routes[1].legs[0].steps).toHaveLength(3);
  });

  it("routes が空配列なら ZERO_RESULTS を返す", () => {
    const result = toLegacyDirections({ routes: [] });
    expect(result).toEqual({ status: "ZERO_RESULTS", routes: [] });
  });

  it("routes キーが無くても ZERO_RESULTS を返す", () => {
    const result = toLegacyDirections({});
    expect(result).toEqual({ status: "ZERO_RESULTS", routes: [] });
  });

  it("error ボディは REQUEST_DENIED に正規化する", () => {
    const raw = {
      error: { code: 403, message: "denied", status: "PERMISSION_DENIED" },
    };
    expect(toLegacyDirections(raw)).toEqual({
      status: "REQUEST_DENIED",
      routes: [],
    });
  });

  it("null や非オブジェクトは UNKNOWN_ERROR を返す", () => {
    expect(toLegacyDirections(null)).toEqual({
      status: "UNKNOWN_ERROR",
      routes: [],
    });
    expect(toLegacyDirections("string")).toEqual({
      status: "UNKNOWN_ERROR",
      routes: [],
    });
  });

  it("start_address / end_address が無い場合はキーを省略する", () => {
    // Routes API はレッグにアドレスを返さない。クライアントの
    // `as String? ?? '出発地'` を効かせるため undefined（キー無し）にする。
    const raw = routesResponse([
      { legs: [{ steps: [walkStep(1000, 600)] }] },
    ]);
    const leg = toLegacyDirections(raw).routes[0].legs[0];
    expect(leg.start_address).toBeUndefined();
    expect(leg.end_address).toBeUndefined();
    expect("start_address" in leg).toBe(false);
    expect("end_address" in leg).toBe(false);
  });
});
