import { describe, expect, it } from "vitest";

import {
  toLegacyAutocomplete,
  toLegacyDetails,
  toLegacyTextSearch,
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

describe("toLegacyTextSearch", () => {
  it("Text Search(New) の places を座標同梱のレガシー predictions に変換する", () => {
    const raw = {
      places: [
        {
          id: "id_mac_a",
          displayName: { text: "マクドナルド 東京駅店" },
          formattedAddress: "東京都千代田区丸の内1-1",
          location: { latitude: 35.681, longitude: 139.767 },
        },
      ],
    };

    const result = toLegacyTextSearch(raw);

    expect(result.status).toBe("OK");
    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0]).toEqual({
      place_id: "id_mac_a",
      description: "東京都千代田区丸の内1-1",
      terms: [{ value: "マクドナルド 東京駅店" }],
      geometry: { location: { lat: 35.681, lng: 139.767 } },
    });
  });

  it("places の距離昇順の並びを保持する", () => {
    const raw = {
      places: [
        {
          id: "near",
          displayName: { text: "近い店" },
          formattedAddress: "A",
          location: { latitude: 35.0, longitude: 139.0 },
        },
        {
          id: "far",
          displayName: { text: "遠い店" },
          formattedAddress: "B",
          location: { latitude: 35.1, longitude: 139.1 },
        },
      ],
    };

    const result = toLegacyTextSearch(raw);

    expect(result.predictions.map((p) => p.place_id)).toEqual(["near", "far"]);
  });

  it("location が無い place はスキップする（座標必須）", () => {
    const raw = {
      places: [
        {
          id: "no_loc",
          displayName: { text: "座標なし" },
          formattedAddress: "C",
        },
        {
          id: "ok",
          displayName: { text: "座標あり" },
          formattedAddress: "D",
          location: { latitude: 35.2, longitude: 139.2 },
        },
      ],
    };

    const result = toLegacyTextSearch(raw);

    expect(result.predictions.map((p) => p.place_id)).toEqual(["ok"]);
  });

  it("places が空配列なら ZERO_RESULTS を返す", () => {
    expect(toLegacyTextSearch({ places: [] })).toEqual({
      status: "ZERO_RESULTS",
      predictions: [],
    });
  });

  it("places キーが無くても ZERO_RESULTS を返す", () => {
    expect(toLegacyTextSearch({})).toEqual({
      status: "ZERO_RESULTS",
      predictions: [],
    });
  });

  it("error ボディは REQUEST_DENIED に正規化する", () => {
    const raw = {
      error: { code: 403, message: "denied", status: "PERMISSION_DENIED" },
    };
    expect(toLegacyTextSearch(raw)).toEqual({
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
