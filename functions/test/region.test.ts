import { describe, expect, it } from "vitest";
import type { HttpsFunction } from "firebase-functions/v2/https";

import { googleWalkProxy, navitimeProxy, placesProxy } from "../src/index";

// NAVITIME（日本の公共交通）向けアプリのため、Functions は日本リージョン
// asia-northeast1 に明示デプロイする。既定の us-central1 は往復遅延が大きい。
// setGlobalOptions の region は各 onRequest の __endpoint.region に反映される。
function endpointRegion(fn: HttpsFunction): string[] | undefined {
  return (fn as unknown as { __endpoint?: { region?: string[] } }).__endpoint
    ?.region;
}

describe("deploy region", () => {
  it.each([
    ["placesProxy", placesProxy],
    ["navitimeProxy", navitimeProxy],
    ["googleWalkProxy", googleWalkProxy],
  ] as const)("%s は asia-northeast1 にデプロイされる", (_name, fn) => {
    expect(endpointRegion(fn)).toEqual(["asia-northeast1"]);
  });
});
