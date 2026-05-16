import * as https from "https";
import * as http from "http";
import { onRequest } from "firebase-functions/v2/https";

const MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? "";

const PLACES_AUTOCOMPLETE_URL =
  "https://maps.googleapis.com/maps/api/place/autocomplete/json";
const PLACES_DETAILS_URL =
  "https://maps.googleapis.com/maps/api/place/details/json";
const DIRECTIONS_URL =
  "https://maps.googleapis.com/maps/api/directions/json";
const GEOCODE_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";

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

function buildUrl(base: string, params: Record<string, string>): string {
  const qs = new URLSearchParams({ ...params, key: MAPS_API_KEY }).toString();
  return `${base}?${qs}`;
}

/** Places Autocomplete / Details プロキシ */
export const placesProxy = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
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
    const data = await fetchJson(
      buildUrl(PLACES_AUTOCOMPLETE_URL, { input, language, components })
    );
    res.json(data);
    return;
  }

  if (action === "details") {
    const placeId = req.query["place_id"] as string | undefined;
    if (!placeId) {
      res.status(400).json({ error: "place_id is required" });
      return;
    }
    const data = await fetchJson(
      buildUrl(PLACES_DETAILS_URL, {
        place_id: placeId,
        fields: "geometry",
      })
    );
    res.json(data);
    return;
  }

  res.status(400).json({ error: "action must be autocomplete or details" });
});

/** Directions API プロキシ（徒歩 / 電車） */
export const directionsProxy = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  const origin = req.query["origin"] as string | undefined;
  const destination = req.query["destination"] as string | undefined;
  const mode = (req.query["mode"] as string | undefined) ?? "walking";
  const departureTime = req.query["departure_time"] as string | undefined;

  if (!origin || !destination) {
    res.status(400).json({ error: "origin and destination are required" });
    return;
  }

  const params: Record<string, string> = {
    origin,
    destination,
    mode,
    language: "ja",
  };
  if (departureTime) params["departure_time"] = departureTime;

  const data = await fetchJson(buildUrl(DIRECTIONS_URL, params));
  res.json(data);
});

/** Geocoding API プロキシ */
export const geocodeProxy = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
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

  const data = await fetchJson(buildUrl(GEOCODE_URL, params));
  res.json(data);
});
