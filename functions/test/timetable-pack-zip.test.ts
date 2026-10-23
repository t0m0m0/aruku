import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { readGtfsZip } from "../src/timetable-pack/zip";

describe("readGtfsZip", () => {
  it("パックに使う GTFS のファイルだけを UTF-8 の文字列で取り出す", () => {
    const zip = zipSync({
      "stops.txt": strToU8("stop_id,stop_name\n1,東京\n"),
      "stop_times.txt": strToU8("trip_id\nT\n"),
      "fare_rules.txt": strToU8("fare_id\n1\n"),
    });
    expect(readGtfsZip(zip)).toEqual({
      "stops.txt": "stop_id,stop_name\n1,東京\n",
      "stop_times.txt": "trip_id\nT\n",
    });
  });

  it("フォルダの中に置かれたファイルも読む", () => {
    const zip = zipSync({ "Toei-Train-GTFS/trips.txt": strToU8("trip_id\nT\n") });
    expect(readGtfsZip(zip)).toEqual({ "trips.txt": "trip_id\nT\n" });
  });

  it("圧縮していない（stored）エントリも読む", () => {
    const zip = zipSync({ "routes.txt": [strToU8("route_id\nR\n"), { level: 0 }] });
    expect(readGtfsZip(zip)).toEqual({ "routes.txt": "route_id\nR\n" });
  });

  it("zip でないバイト列は、読めないと分かるエラーにする", () => {
    expect(() => readGtfsZip(strToU8("<html>403 Forbidden</html>"))).toThrow(/zip/);
  });
});
