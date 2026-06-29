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
