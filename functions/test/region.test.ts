import { describe, expect, it } from "vitest";
import type { HttpsFunction } from "firebase-functions/v2/https";

import {
  googleWalkMatrixProxy,
  googleWalkProxy,
  navitimeProxy,
  placesProxy,
} from "../src/index";

// setGlobalOptions で設定するデプロイ既定値（region / maxInstances）は各 onRequest
// の __endpoint に反映される。__endpoint は firebase-functions の非公開 API のため、
// SDK 更新で構造が変わると設定漏れではなくこの参照が壊れて失敗する場合がある。
// テストが落ちたらまず __endpoint の形を確認すること（SDK 更新時は追従が必要）。
function endpoint(
  fn: HttpsFunction
): { region?: string[]; maxInstances?: number } | undefined {
  return (
    fn as unknown as {
      __endpoint?: { region?: string[]; maxInstances?: number };
    }
  ).__endpoint;
}

// setGlobalOptions は後続の全 onRequest に適用されるため、代表 4 プロキシすべてを
// 検証対象にする（1 つでも定義漏れがあれば気付ける）。
const ALL_PROXIES = [
  ["navitimeProxy", navitimeProxy],
  ["googleWalkProxy", googleWalkProxy],
  ["googleWalkMatrixProxy", googleWalkMatrixProxy],
  ["placesProxy", placesProxy],
] as const;

// maxInstances の期待値（issue #160）。src/index.ts の設定値と一致させる。
const EXPECTED_MAX_INSTANCES = 10;

describe("deploy region", () => {
  // NAVITIME（日本の公共交通）向けアプリのため、Functions は日本リージョン
  // asia-northeast1 に明示デプロイする。既定の us-central1 は往復遅延が大きい。
  it.each(ALL_PROXIES)("%s は asia-northeast1 にデプロイされる", (_name, fn) => {
    expect(endpoint(fn)?.region).toEqual(["asia-northeast1"]);
  });
});

describe("maxInstances 上限", () => {
  // トラフィック急増・悪用時にインスタンスが無制限にスケールし課金が暴発するのを
  // 防ぐため、各関数に maxInstances の安全弁を設ける（issue #160）。
  it.each(ALL_PROXIES)("%s は maxInstances が設定される", (_name, fn) => {
    expect(endpoint(fn)?.maxInstances).toBe(EXPECTED_MAX_INSTANCES);
  });
});
