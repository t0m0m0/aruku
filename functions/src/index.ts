import * as https from "https";
import * as http from "http";
import { onRequest, Request } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

import { toLegacyAutocomplete, toLegacyDetails } from "./places-transform";

const mapsKeySecret = defineSecret("GOOGLE_MAPS_API_KEY");

// ローカル（エミュレーター）は Keychain から export した process.env を使用。
// 本番は Secret Manager から取得。
function getMapsApiKey(): string {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return process.env.GOOGLE_MAPS_API_KEY ?? "";
  }
  return mapsKeySecret.value();
}

const PLACES_AUTOCOMPLETE_NEW_URL =
  "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS_NEW_BASE = "https://places.googleapis.com/v1/places";
const DIRECTIONS_URL =
  "https://maps.googleapis.com/maps/api/directions/json";
const GEOCODE_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";

const ALLOWED_MODES = new Set(["walking", "transit", "driving", "bicycling"]);

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

/** Directions API プロキシ（徒歩 / 電車） */
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

  const params: Record<string, string> = {
    origin,
    destination,
    mode: rawMode,
    language: "ja",
  };
  if (departureTime) params["departure_time"] = departureTime;
  if (alternatives) params["alternatives"] = "true";

  const data = await fetchJson(buildUrl(DIRECTIONS_URL, params, getMapsApiKey()));
  res.json(data);
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
