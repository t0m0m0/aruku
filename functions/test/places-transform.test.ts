import { describe, expect, it } from "vitest";

import {
  toLegacyAutocomplete,
  toLegacyDetails,
} from "../src/places-transform";

describe("toLegacyAutocomplete", () => {
  it("Places API (New) の suggestions をレガシー predictions に変換する", () => {
    const raw = {
      suggestions: [
        {
          placePrediction: {
            placeId: "id_shibuya",
            text: { text: "渋谷駅, 東京都渋谷区" },
            structuredFormat: {
              mainText: { text: "渋谷駅" },
              secondaryText: { text: "東京都渋谷区" },
            },
          },
        },
      ],
    };

    const result = toLegacyAutocomplete(raw);

    expect(result.status).toBe("OK");
    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0]).toEqual({
      place_id: "id_shibuya",
      description: "渋谷駅, 東京都渋谷区",
      terms: [{ value: "渋谷駅" }, { value: "東京都渋谷区" }],
    });
  });

  it("queryPrediction はスキップし placePrediction のみ変換する", () => {
    const raw = {
      suggestions: [
        { queryPrediction: { text: { text: "ラーメン" } } },
        {
          placePrediction: {
            placeId: "id_a",
            text: { text: "Aビル, 東京" },
            structuredFormat: {
              mainText: { text: "Aビル" },
              secondaryText: { text: "東京" },
            },
          },
        },
      ],
    };

    const result = toLegacyAutocomplete(raw);

    expect(result.status).toBe("OK");
    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0].place_id).toBe("id_a");
  });

  it("origin 指定時の distanceMeters を distance_meters として取り込む（#146 C案）", () => {
    const raw = {
      suggestions: [
        {
          placePrediction: {
            placeId: "id_far",
            text: { text: "遠い店, 東京" },
            structuredFormat: { mainText: { text: "遠い店" } },
            distanceMeters: 1800,
          },
        },
        {
          placePrediction: {
            placeId: "id_near",
            text: { text: "近い店, 東京" },
            structuredFormat: { mainText: { text: "近い店" } },
            distanceMeters: 160,
          },
        },
      ],
    };

    const result = toLegacyAutocomplete(raw);

    // 並びは上流のまま（関連度順）保持し、距離はフィールドとして付与するだけ。
    expect(result.predictions.map((p) => p.place_id)).toEqual([
      "id_far",
      "id_near",
    ]);
    expect(result.predictions[0].distance_meters).toBe(1800);
    expect(result.predictions[1].distance_meters).toBe(160);
  });

  it("distanceMeters が無い候補は distance_meters を持たない", () => {
    const raw = {
      suggestions: [
        {
          placePrediction: {
            placeId: "id_a",
            text: { text: "Aビル, 東京" },
            structuredFormat: { mainText: { text: "Aビル" } },
          },
        },
      ],
    };

    const result = toLegacyAutocomplete(raw);

    expect(result.predictions[0].distance_meters).toBeUndefined();
  });

  it("secondaryText が無い場合は terms を mainText のみにする", () => {
    const raw = {
      suggestions: [
        {
          placePrediction: {
            placeId: "id_b",
            text: { text: "東京タワー" },
            structuredFormat: { mainText: { text: "東京タワー" } },
          },
        },
      ],
    };

    const result = toLegacyAutocomplete(raw);

    expect(result.predictions[0].terms).toEqual([{ value: "東京タワー" }]);
  });

  it("suggestions が空配列なら ZERO_RESULTS を返す", () => {
    const result = toLegacyAutocomplete({ suggestions: [] });
    expect(result).toEqual({ status: "ZERO_RESULTS", predictions: [] });
  });

  it("suggestions キーが無くても ZERO_RESULTS を返す", () => {
    const result = toLegacyAutocomplete({});
    expect(result).toEqual({ status: "ZERO_RESULTS", predictions: [] });
  });

  it("placePrediction が一つも無ければ ZERO_RESULTS を返す", () => {
    const raw = {
      suggestions: [{ queryPrediction: { text: { text: "x" } } }],
    };
    expect(toLegacyAutocomplete(raw)).toEqual({
      status: "ZERO_RESULTS",
      predictions: [],
    });
  });

  it("error ボディは REQUEST_DENIED に正規化する", () => {
    const raw = {
      error: { code: 403, message: "denied", status: "PERMISSION_DENIED" },
    };
    expect(toLegacyAutocomplete(raw)).toEqual({
      status: "REQUEST_DENIED",
      predictions: [],
    });
  });
});

describe("toLegacyDetails", () => {
  it("location をレガシー result.geometry.location に変換する", () => {
    const raw = { location: { latitude: 35.658, longitude: 139.701 } };

    const result = toLegacyDetails(raw);

    expect(result).toEqual({
      status: "OK",
      result: { geometry: { location: { lat: 35.658, lng: 139.701 } } },
    });
  });

  it("location が無ければ NOT_FOUND を返す", () => {
    expect(toLegacyDetails({})).toEqual({ status: "NOT_FOUND" });
  });

  it("error ボディは REQUEST_DENIED に正規化する", () => {
    const raw = {
      error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" },
    };
    expect(toLegacyDetails(raw)).toEqual({ status: "REQUEST_DENIED" });
  });
});
