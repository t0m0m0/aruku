import * as https from "https";
import * as http from "http";
import { onRequest, Request } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

import { toLegacyAutocomplete, toLegacyDetails } from "./places-transform";
import { toLegacyDirections } from "./routes-transform";

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
const ROUTES_API_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOCODE_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";

// Routes API のレッグに startAddress/endAddress は存在しない（座標のみ）。
// 存在しないパスを field mask に含めると API は 400 を返すため指定しない。
const ROUTES_FIELD_MASK = [
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.transitDetails.stopDetails.departureStop.name",
  "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
  "routes.legs.steps.transitDetails.transitLine.name",
  "routes.legs.steps.transitDetails.stopCount",
].join(",");

function toRoutesApiMode(legacyMode: string): string {
  switch (legacyMode) {
    case "walking":   return "WALK";
    case "transit":   return "TRANSIT";
    case "driving":   return "DRIVE";
    case "bicycling": return "BICYCLE";
    default:          return "WALK";
  }
}

function toLocationEndpoint(s: string):
  | { location: { latLng: { latitude: number; longitude: number } } }
  | { address: string } {
  const parts = s.split(",").map((p) => parseFloat(p.trim()));
  if (
    parts.length === 2 &&
    !isNaN(parts[0]) &&
    !isNaN(parts[1])
  ) {
    return { location: { latLng: { latitude: parts[0], longitude: parts[1] } } };
  }
  return { address: s };
}

const ALLOWED_MODES = new Set(["walking", "transit", "driving", "bicycling"]);

const NAVITIME_HOST = "navitime-route-totalnavi.p.rapidapi.com";
const NAVITIME_ROUTE_URL = `https://${NAVITIME_HOST}/route_transit`;

const NAVITIME_WALK_HOST = "navitime-route-walk.p.rapidapi.com";
const NAVITIME_WALK_URL = `https://${NAVITIME_WALK_HOST}/route_walk`;

// クライアントから透過を許可するパラメータ。datum/coord_unit はサーバ固定。
// options=railway_calling_at で乗車列車の途中停車駅を取得する。
const NAVITIME_ALLOWED_PARAMS = [
  "start",
  "goal",
  "start_time",
  "term",
  "limit",
  "options",
];

// 徒歩ルート（origin→駅）取得用。time/distance のみ必要なら shape は不要。
const NAVITIME_WALK_ALLOWED_PARAMS = [
  "start",
  "goal",
  "start_time",
  "speed",
  "condition",
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

export function buildNavitimeWalkUrl(query: Record<string, string | undefined>): string {
  return buildAllowedUrl(NAVITIME_WALK_URL, NAVITIME_WALK_ALLOWED_PARAMS, query);
}

// Per-instance in-memory rate limiter (30 req/min per IP).
// Note: Firebase Functions may run as multiple instances, so this limit is
// per-instance. For cross-instance enforcement, enable Firebase App Check.
const _rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  if (_rateLimitMap.size > 1000) {
    for (const [k, v] of _rateLimitMap) {
      if (now > v.resetAt) _rateLimitMap.delete(k);
    }
  }
  const entry = _rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  if (Array.isArray(fwd)) return fwd[0].trim();
  return req.ip ?? "unknown";
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? https.get : http.get;
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

function buildUrl(base: string, params: Record<string, string>, key: string): string {
  const qs = new URLSearchParams({ ...params, key }).toString();
  return `${base}?${qs}`;
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
// to browser CORS restrictions. For production, enable Firebase App Check to
// prevent unauthorized access to this proxy.

/** Places Autocomplete / Details プロキシ */
export const placesProxy = onRequest({ secrets: [mapsKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  if (!checkRateLimit(clientIp(req))) {
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

/** Directions プロキシ（Routes API (New) 経由、レガシー形式で返す） */
export const directionsProxy = onRequest({ secrets: [mapsKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  if (!checkRateLimit(clientIp(req))) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const origin = req.query["origin"] as string | undefined;
  const destination = req.query["destination"] as string | undefined;
  const rawMode = (req.query["mode"] as string | undefined) ?? "walking";
  const departureTime = req.query["departure_time"] as string | undefined;
  const alternatives = req.query["alternatives"] === "true";

  if (!origin || !destination) {
    res.status(400).json({ error: "origin and destination are required" });
    return;
  }

  if (!ALLOWED_MODES.has(rawMode)) {
    res
      .status(400)
      .json({ error: `mode must be one of: ${[...ALLOWED_MODES].join(", ")}` });
    return;
  }

  const body: Record<string, unknown> = {
    origin: toLocationEndpoint(origin),
    destination: toLocationEndpoint(destination),
    travelMode: toRoutesApiMode(rawMode),
    computeAlternativeRoutes: alternatives,
    languageCode: "ja",
  };
  if (departureTime) {
    body["departureTime"] = new Date(
      parseInt(departureTime, 10) * 1000
    ).toISOString();
  }

  const data = await requestJsonNew(
    ROUTES_API_URL,
    "POST",
    {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getMapsApiKey(),
      "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    },
    JSON.stringify(body)
  );

  // Routes API はエラー時も HTTP 200 で {error:...} を返すことがあり、
  // 変換層が REQUEST_DENIED へ畳むため原因が埋もれる。
  // API キー制限・課金・無効化などの切り分け用にエラー本体を残す。
  const record = data as Record<string, unknown> | null;
  if (record && record["error"]) {
    console.error(
      "[directionsProxy] Routes API error:",
      JSON.stringify(record["error"])
    );
  }

  res.json(toLegacyDirections(data));
});

/** Geocoding API プロキシ */
export const geocodeProxy = onRequest({ secrets: [mapsKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  if (!checkRateLimit(clientIp(req))) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const address = req.query["address"] as string | undefined;
  const latlng = req.query["latlng"] as string | undefined;

  if (!address && !latlng) {
    res.status(400).json({ error: "address or latlng is required" });
    return;
  }

  const params: Record<string, string> = { language: "ja" };
  if (address) params["address"] = address;
  if (latlng) params["latlng"] = latlng;

  const data = await fetchJson(buildUrl(GEOCODE_URL, params, getMapsApiKey()));
  res.json(data);
});

/** NAVITIME route_transit プロキシ（RapidAPI 経由、レスポンスは無加工で返す） */
export const navitimeProxy = onRequest({ secrets: [navitimeKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  if (!checkRateLimit(clientIp(req))) {
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

/** NAVITIME route_walk プロキシ（origin→駅 の徒歩ルート、レスポンスは無加工で返す） */
export const navitimeWalkProxy = onRequest({ secrets: [navitimeKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  if (!checkRateLimit(clientIp(req))) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const start = req.query["start"] as string | undefined;
  const goal = req.query["goal"] as string | undefined;

  if (!start || !goal) {
    res.status(400).json({ error: "start and goal are required" });
    return;
  }

  const data = await requestJsonNew(
    buildNavitimeWalkUrl(req.query as Record<string, string | undefined>),
    "GET",
    {
      "X-RapidAPI-Key": getNavitimeApiKey(),
      "X-RapidAPI-Host": NAVITIME_WALK_HOST,
    }
  );

  const record = data as Record<string, unknown> | null;
  if (record && record["message"] && !record["items"]) {
    console.error(
      "[navitimeWalkProxy] NAVITIME API error:",
      JSON.stringify(record["message"])
    );
    res.status(502).json(data);
    return;
  }

  res.json(data);
});
