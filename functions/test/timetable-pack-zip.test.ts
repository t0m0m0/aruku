import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { readGtfsZip } from "../src/timetable-pack/zip";

// パックを作るのに欠かせないファイル。運行日は calendar.txt か calendar_dates.txt のどちらか。
const REQUIRED = {
  "stops.txt": "stop_id\nA\n",
  "routes.txt": "route_id\nR\n",
  "trips.txt": "trip_id\nT\n",
  "stop_times.txt": "trip_id\nT\n",
  "calendar_dates.txt": "service_id\nS\n",
};
const zipOf = (files: Record<string, string>, prefix = ""): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([n, t]) => [prefix + n, strToU8(t)])));

describe("readGtfsZip", () => {
  it("パックに使う GTFS のファイルだけを UTF-8 の文字列で取り出す", () => {
    const zip = zipOf({ ...REQUIRED, "stops.txt": "stop_id,stop_name\n1,東京\n", "fare_rules.txt": "fare_id\n1\n" });
    expect(readGtfsZip(zip)).toEqual({ ...REQUIRED, "stops.txt": "stop_id,stop_name\n1,東京\n" });
  });

  it("フォルダの中に置かれたファイルも読む", () => {
    expect(readGtfsZip(zipOf(REQUIRED, "Toei-Train-GTFS/"))).toEqual(REQUIRED);
  });

  it("圧縮していない（stored）エントリも読む", () => {
    const zip = zipSync({
      ...Object.fromEntries(Object.entries(REQUIRED).map(([n, t]) => [n, strToU8(t)])),
      "routes.txt": [strToU8("route_id\nR\n"), { level: 0 }],
    });
    expect(readGtfsZip(zip)["routes.txt"]).toBe("route_id\nR\n");
  });

  it.each(["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"])(
    "%s が欠けた zip は、欠けたパックで前回分を上書きしないようエラーにする",
    (missing) => {
      const files: Record<string, string> = { ...REQUIRED };
      delete files[missing];
      expect(() => readGtfsZip(zipOf(files))).toThrow(missing);
    },
  );

  it("calendar.txt も calendar_dates.txt も無い zip はエラーにする", () => {
    const files: Record<string, string> = { ...REQUIRED };
    delete files["calendar_dates.txt"];
    expect(() => readGtfsZip(zipOf(files))).toThrow(/calendar/);
    expect(() => readGtfsZip(zipOf({ ...files, "calendar.txt": "service_id\nS\n" }))).not.toThrow();
  });

  it("zip でないバイト列は、読めないと分かるエラーにする", () => {
    expect(() => readGtfsZip(strToU8("<html>403 Forbidden</html>"))).toThrow(/zip/);
  });
});
