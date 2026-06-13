import { describe, expect, it } from "vitest";

import {
  buildRoutesMatrixBody,
  matrixElementCount,
  MATRIX_MAX_ELEMENTS,
  parseLatLngList,
} from "../src/index";

describe("parseLatLngList", () => {
  it("セミコロン区切りの 'lat,lng' を waypoint 配列へ変換する", () => {
    expect(parseLatLngList("35.7,139.75;35.681,139.767")).toEqual([
      { latitude: 35.7, longitude: 139.75 },
      { latitude: 35.681, longitude: 139.767 },
    ]);
  });

  it("単一の座標も配列で返す", () => {
    expect(parseLatLngList("35.7,139.75")).toEqual([
      { latitude: 35.7, longitude: 139.75 },
    ]);
  });

  it("空文字・undefined は null", () => {
    expect(parseLatLngList("")).toBeNull();
    expect(parseLatLngList(undefined)).toBeNull();
  });

  it("いずれかの座標が不正なら全体を null とする", () => {
    expect(parseLatLngList("35.7,139.75;not-a-coord")).toBeNull();
    expect(parseLatLngList("35.7;139.75")).toBeNull();
  });
});

describe("matrixElementCount", () => {
  it("origins × destinations の要素数を返す", () => {
    expect(matrixElementCount(1, 10)).toBe(10);
    expect(matrixElementCount(10, 1)).toBe(10);
    expect(matrixElementCount(5, 5)).toBe(25);
  });
});

describe("buildRoutesMatrixBody", () => {
  it("origins/destinations を waypoint.latLng で、travelMode を WALK で含める", () => {
    const body = JSON.parse(
      buildRoutesMatrixBody(
        [{ latitude: 35.7, longitude: 139.75 }],
        [
          { latitude: 35.681, longitude: 139.767 },
          { latitude: 35.69, longitude: 139.7 },
        ]
      )
    );
    expect(body.origins).toEqual([
      { waypoint: { location: { latLng: { latitude: 35.7, longitude: 139.75 } } } },
    ]);
    expect(body.destinations).toEqual([
      {
        waypoint: {
          location: { latLng: { latitude: 35.681, longitude: 139.767 } },
        },
      },
      {
        waypoint: { location: { latLng: { latitude: 35.69, longitude: 139.7 } } },
      },
    ]);
    expect(body.travelMode).toBe("WALK");
  });
});

describe("MATRIX_MAX_ELEMENTS", () => {
  it("要素数上限が定義されている（課金暴発の防止）", () => {
    expect(MATRIX_MAX_ELEMENTS).toBeGreaterThan(0);
  });
});
