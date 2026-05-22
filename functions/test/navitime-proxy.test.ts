import { describe, expect, it } from "vitest";

import { buildNavitimeUrl } from "../src/index";

describe("buildNavitimeUrl", () => {
  it("必須パラメータ（start/goal/start_time）を含める", () => {
    const url = new URL(
      buildNavitimeUrl({
        start: "35.7,139.7",
        goal: "35.65,139.7",
        start_time: "2026-05-22T09:00:00",
      })
    );
    expect(url.origin + url.pathname).toBe(
      "https://navitime-route-totalnavi.p.rapidapi.com/route_transit"
    );
    expect(url.searchParams.get("start")).toBe("35.7,139.7");
    expect(url.searchParams.get("goal")).toBe("35.65,139.7");
    expect(url.searchParams.get("start_time")).toBe("2026-05-22T09:00:00");
  });

  it("既定値（datum=wgs84, coord_unit=degree）を付与する", () => {
    const url = new URL(buildNavitimeUrl({ start: "1,1", goal: "2,2" }));
    expect(url.searchParams.get("datum")).toBe("wgs84");
    expect(url.searchParams.get("coord_unit")).toBe("degree");
  });

  it("許可外パラメータは透過しない", () => {
    const url = new URL(
      buildNavitimeUrl({
        start: "1,1",
        goal: "2,2",
        key: "leak",
        arbitrary: "x",
      } as Record<string, string>)
    );
    expect(url.searchParams.has("key")).toBe(false);
    expect(url.searchParams.has("arbitrary")).toBe(false);
  });

  it("空文字・未指定の任意パラメータは除外する", () => {
    const url = new URL(
      buildNavitimeUrl({ start: "1,1", goal: "2,2", start_time: "" })
    );
    expect(url.searchParams.has("start_time")).toBe(false);
  });

  it("任意の透過パラメータ（term/limit）を含める", () => {
    const url = new URL(
      buildNavitimeUrl({ start: "1,1", goal: "2,2", limit: "5", term: "1440" })
    );
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("term")).toBe("1440");
  });
});
