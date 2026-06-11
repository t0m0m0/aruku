import * as https from "https";
import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest, Request } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { Response } from "express";
import { initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";

import { toLegacyAutocomplete, toLegacyDetails } from "./places-transform";
import { checkRateLimit, WALK_RATE_LIMIT } from "./rate-limiter";

// レート制限ユーティリティはテスト互換のため再エクスポートする。
export {
  checkRateLimit,
  checkRateLimitInMemory,
  checkRateLimitFirestore,
  resetRateLimit,
  rateLimitMapSize,
  RATE_LIMIT,
  WALK_RATE_LIMIT,
} from "./rate-limiter";

initializeApp();

// NAVITIME（日本の公共交通）向けアプリのため日本リージョンへ明示デプロイする。
// 既定の us-central1 は日本から遠く往復遅延が大きい。各 onRequest 定義より前に
// 呼ぶ必要があるため initializeApp 直後に置く。
setGlobalOptions({ region: "asia-northeast1" });

const mapsKeySecret = defineSecret("GOOGLE_MAPS_API_KEY");
const navitimeKeySecret = defineSecret("NAVITIME_RAPIDAPI_KEY");

// ローカル（エミュレーター）は Keychain から export した process.env を使用。
// 本番は Secret Manager から取得。
function getMapsApiKey(): string {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return process.env.GOOGLE_MAPS_API_KEY ?? "";
  }
  return mapsKeySecret.value();
}

function getNavitimeApiKey(): string {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return process.env.NAVITIME_RAPIDAPI_KEY ?? "";
  }
  return navitimeKeySecret.value();
}

const PLACES_AUTOCOMPLETE_NEW_URL =
  "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS_NEW_BASE = "https://places.googleapis.com/v1/places";

// Google Routes API。徒歩ルートの街路追従ジオメトリ（encodedPolyline）と
// 距離・所要時間を返す。NAVITIME が徒歩 shape を返さないため徒歩線はここから得る。
const ROUTES_COMPUTE_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";
// 課金は FieldMask で要求したフィールドに依存する。徒歩線・距離・時間のみ取得。
const ROUTES_FIELD_MASK =
  "routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration";

const NAVITIME_HOST = "navitime-route-totalnavi.p.rapidapi.com";
const NAVITIME_ROUTE_URL = `https://${NAVITIME_HOST}/route_transit`;

// クライアントから透過を許可するパラメータ。datum/coord_unit はサーバ固定。
// options=railway_calling_at で乗車列車の途中停車駅を取得する。
// shape=true でナビ用の区間ジオメトリ（折れ線座標）を取得する。
const NAVITIME_ALLOWED_PARAMS = [
  "start",
  "goal",
  "start_time",
  "term",
  "limit",
  "options",
  "shape",
];

function buildAllowedUrl(
  base: string,
  allowed: string[],
  query: Record<string, string | undefined>
): string {
  const params: Record<string, string> = { datum: "wgs84", coord_unit: "degree" };
  for (const k of allowed) {
    const v = query[k];
    if (typeof v === "string" && v.length > 0) params[k] = v;
  }
  return `${base}?${new URLSearchParams(params).toString()}`;
}

export function buildNavitimeUrl(query: Record<string, string | undefined>): string {
  return buildAllowedUrl(NAVITIME_ROUTE_URL, NAVITIME_ALLOWED_PARAMS, query);
}

/** "lat,lng" 形式の座標を Routes API の waypoint へ変換する。不正な値は null。 */
function parseLatLng(
  value: string | undefined
): { latitude: number; longitude: number } | null {
  if (typeof value !== "string") return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

/** Routes API computeRoutes（徒歩）のリクエストボディを生成する。 */
export function buildRoutesWalkBody(
  start: { latitude: number; longitude: number },
  goal: { latitude: number; longitude: number }
): string {
  return JSON.stringify({
    origin: { location: { latLng: start } },
    destination: { location: { latLng: goal } },
    travelMode: "WALK",
  });
}

export function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  if (Array.isArray(fwd)) return fwd[0].trim();
  return req.ip ?? "unknown";
}

// Firebase App Check verification for raw HTTP functions. onRequest (unlike
// onCall) has no built-in enforceAppCheck, so the X-Firebase-AppCheck header
// must be verified explicitly. Without a valid token the request is rejected
// with 401, blocking unauthenticated access to these billable proxies.
// The emulator is exempted so local development works without App Check setup.
export async function verifyAppCheck(req: Request, res: Response): Promise<boolean> {
  if (process.env.FUNCTIONS_EMULATOR === "true") return true;
  const token = req.header("X-Firebase-AppCheck");
  if (!token) {
    console.warn("AppCheck: token missing");
    res.status(401).json({ error: "App Check token missing" });
    return false;
  }
  try {
    await getAppCheck().verifyToken(token);
    return true;
  } catch (e) {
    console.warn("AppCheck: token invalid", e);
    res.status(401).json({ error: "App Check token invalid" });
    return false;
  }
}

// Places API (New) 用。エラー時も JSON ボディ（{error:...}）を返すため
// ステータスコードに関わらずパースして呼び出し側（変換層）へ渡す。
function requestJsonNew(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// CORS is set to * because clients are Flutter mobile apps which are not subject
// to browser CORS restrictions. Unauthorized access is prevented by Firebase
// App Check: every handler calls verifyAppCheck() to validate the
// X-Firebase-AppCheck token before doing any billable work.

/** Places Autocomplete / Details プロキシ */
export const placesProxy = onRequest({ secrets: [mapsKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck");
    res.status(204).send("");
    return;
  }

  if (!(await verifyAppCheck(req, res))) return;

  if (!(await checkRateLimit(clientIp(req)))) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const action = req.query["action"] as string | undefined;

  if (action === "autocomplete") {
    const input = req.query["input"] as string | undefined;
    const language = (req.query["language"] as string | undefined) ?? "ja";
    const components =
      (req.query["components"] as string | undefined) ?? "country:jp";
    if (!input) {
      res.status(400).json({ error: "input is required" });
      return;
    }
    // レガシー components="country:jp|country:us" を新 API の
    // includedRegionCodes へ変換する。
    const regionCodes = components
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.startsWith("country:"))
      .map((c) => c.slice("country:".length).toLowerCase())
      .filter((c) => c.length > 0);

    const data = await requestJsonNew(
      PLACES_AUTOCOMPLETE_NEW_URL,
      "POST",
      {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getMapsApiKey(),
      },
      JSON.stringify({
        input,
        languageCode: language,
        ...(regionCodes.length > 0
          ? { includedRegionCodes: regionCodes }
          : {}),
      })
    );
    res.json(toLegacyAutocomplete(data));
    return;
  }

  if (action === "details") {
    const placeId = req.query["place_id"] as string | undefined;
    if (!placeId) {
      res.status(400).json({ error: "place_id is required" });
      return;
    }
    const data = await requestJsonNew(
      `${PLACES_DETAILS_NEW_BASE}/${encodeURIComponent(placeId)}`,
      "GET",
      {
        "X-Goog-Api-Key": getMapsApiKey(),
        "X-Goog-FieldMask": "location",
      }
    );
    res.json(toLegacyDetails(data));
    return;
  }

  res.status(400).json({ error: "action must be autocomplete or details" });
});

/** NAVITIME route_transit プロキシ（RapidAPI 経由、レスポンスは無加工で返す） */
export const navitimeProxy = onRequest({ secrets: [navitimeKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck");
    res.status(204).send("");
    return;
  }

  if (!(await verifyAppCheck(req, res))) return;

  if (!(await checkRateLimit(clientIp(req)))) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const start = req.query["start"] as string | undefined;
  const goal = req.query["goal"] as string | undefined;
  const startTime = req.query["start_time"] as string | undefined;

  if (!start || !goal || !startTime) {
    res
      .status(400)
      .json({ error: "start, goal and start_time are required" });
    return;
  }

  const data = await requestJsonNew(
    buildNavitimeUrl(req.query as Record<string, string | undefined>),
    "GET",
    {
      "X-RapidAPI-Key": getNavitimeApiKey(),
      "X-RapidAPI-Host": NAVITIME_HOST,
    }
  );

  // RapidAPI/NAVITIME はエラー時に items を含まず {message:...} 等を返す。
  // 認証エラー・クォータ超過と「ルートなし」を区別するため 502 で返す。
  const record = data as Record<string, unknown> | null;
  if (record && record["message"] && !record["items"]) {
    console.error(
      "[navitimeProxy] NAVITIME API error:",
      JSON.stringify(record["message"])
    );
    res.status(502).json(data);
    return;
  }

  res.json(data);
});


/**
 * Google Routes 徒歩プロキシ。start/goal（"lat,lng"）から computeRoutes を
 * travelMode=WALK で叩き、街路追従の encodedPolyline・距離・所要時間を返す。
 * レスポンスは無加工で返す（変換はクライアント側）。
 */
export const googleWalkProxy = onRequest({ secrets: [mapsKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck");
    res.status(204).send("");
    return;
  }

  if (!(await verifyAppCheck(req, res))) return;

  if (!(await checkRateLimit(clientIp(req), WALK_RATE_LIMIT))) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const start = parseLatLng(req.query["start"] as string | undefined);
  const goal = parseLatLng(req.query["goal"] as string | undefined);

  if (!start || !goal) {
    res
      .status(400)
      .json({ error: "start and goal are required as 'lat,lng'" });
    return;
  }

  const data = await requestJsonNew(
    ROUTES_COMPUTE_URL,
    "POST",
    {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getMapsApiKey(),
      "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    },
    buildRoutesWalkBody(start, goal)
  );

  // Routes API はエラー時 {error:{...}} を返し routes を含まない。
  // 認証・クォータ等の失敗を「ルートなし」と区別するため 502 で返す。
  const record = data as Record<string, unknown> | null;
  if (record && record["error"] && !record["routes"]) {
    console.error(
      "[googleWalkProxy] Routes API error:",
      JSON.stringify(record["error"])
    );
    res.status(502).json(data);
    return;
  }

  res.json(data);
});
