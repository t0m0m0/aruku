// Places API (New) のレスポンスを、Flutter クライアントが期待する
// レガシー Places API 形式へ変換する純粋関数群。
// プロキシを変換層にすることでクライアント側の改修を不要にする。

export interface LegacyPrediction {
  place_id: string;
  description: string;
  terms: { value: string }[];
}

export interface LegacyAutocompleteResponse {
  status: string;
  predictions: LegacyPrediction[];
}

export interface LegacyDetailsResponse {
  status: string;
  result?: { geometry: { location: { lat: number; lng: number } } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

const ZERO_AUTOCOMPLETE: LegacyAutocompleteResponse = {
  status: "ZERO_RESULTS",
  predictions: [],
};

export function toLegacyAutocomplete(raw: unknown): LegacyAutocompleteResponse {
  const body = asRecord(raw);
  if (!body) return ZERO_AUTOCOMPLETE;
  if (body["error"]) return { status: "REQUEST_DENIED", predictions: [] };

  const suggestions = body["suggestions"];
  if (!Array.isArray(suggestions)) return ZERO_AUTOCOMPLETE;

  const predictions: LegacyPrediction[] = [];
  for (const entry of suggestions) {
    const pp = asRecord(asRecord(entry)?.["placePrediction"]);
    if (!pp) continue;

    const placeId = pp["placeId"];
    if (typeof placeId !== "string") continue;

    const description = asRecord(pp["text"])?.["text"];
    const structured = asRecord(pp["structuredFormat"]);
    const mainText = asRecord(structured?.["mainText"])?.["text"];
    const secondaryText = asRecord(structured?.["secondaryText"])?.["text"];

    const terms: { value: string }[] = [];
    if (typeof mainText === "string") terms.push({ value: mainText });
    if (typeof secondaryText === "string") {
      terms.push({ value: secondaryText });
    }

    predictions.push({
      place_id: placeId,
      description: typeof description === "string" ? description : "",
      terms,
    });
  }

  if (predictions.length === 0) return ZERO_AUTOCOMPLETE;
  return { status: "OK", predictions };
}

export function toLegacyDetails(raw: unknown): LegacyDetailsResponse {
  const body = asRecord(raw);
  if (!body) return { status: "NOT_FOUND" };
  if (body["error"]) return { status: "REQUEST_DENIED" };

  const location = asRecord(body["location"]);
  const lat = location?.["latitude"];
  const lng = location?.["longitude"];
  if (typeof lat !== "number" || typeof lng !== "number") {
    return { status: "NOT_FOUND" };
  }

  return {
    status: "OK",
    result: { geometry: { location: { lat, lng } } },
  };
}
