import { describe, expect, it } from "vitest";
import type { HttpsFunction } from "firebase-functions/v2/https";

import { googleWalkProxy, navitimeProxy } from "../src/index";

// NAVITIME（日本の公共交通）向けアプリのため、Functions は日本リージョン
// asia-northeast1 に明示デプロイする。既定の us-central1 は往復遅延が大きい。
// setGlobalOptions の region は各 onRequest の __endpoint.region に反映される。
//
// 注意: __endpoint は firebase-functions の非公開 API。SDK 更新で構造が変わると
// region 設定漏れではなくこの参照が壊れて失敗する場合がある。テストが落ちたら
// まず __endpoint の形を確認すること（SDK 更新時は本関数の追従が必要）。
function endpointRegion(fn: HttpsFunction): string[] | undefined {
  return (fn as unknown as { __endpoint?: { region?: string[] } }).__endpoint
    ?.region;
}

describe("deploy region", () => {
  it.each([
    ["navitimeProxy", navitimeProxy],
    ["googleWalkProxy", googleWalkProxy],
  ] as const)("%s は asia-northeast1 にデプロイされる", (_name, fn) => {
    expect(endpointRegion(fn)).toEqual(["asia-northeast1"]);
  });
});
