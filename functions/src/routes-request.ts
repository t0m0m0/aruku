// Routes API (New) computeRoutes のリクエストボディを組み立てる純粋関数。
// プロキシ本体（index.ts）から切り出すことで単体テスト可能にする。

export function toRoutesApiMode(legacyMode: string): string {
  switch (legacyMode) {
    case "walking":   return "WALK";
    case "transit":   return "TRANSIT";
    case "driving":   return "DRIVE";
    case "bicycling": return "BICYCLE";
    default:          return "WALK";
  }
}

export function toLocationEndpoint(s: string):
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

export interface RoutesRequestParams {
  origin: string;
  destination: string;
  rawMode: string;
  alternatives: boolean;
  departureTime?: string;
}

export function buildRoutesRequestBody(
  params: RoutesRequestParams
): Record<string, unknown> {
  const travelMode = toRoutesApiMode(params.rawMode);

  const body: Record<string, unknown> = {
    origin: toLocationEndpoint(params.origin),
    destination: toLocationEndpoint(params.destination),
    travelMode,
    computeAlternativeRoutes: params.alternatives,
    languageCode: "ja",
  };

  // TRANSIT は transitPreferences の指定が推奨されており、未指定だと一部
  // 地域・経路でルートが返らず ZERO_RESULTS になるケースがある（#40）。
  // routingPreference は本アプリの徒歩比率最大化方針と競合し得るため
  // 指定せず、対象交通機関のみ明示する。
  if (travelMode === "TRANSIT") {
    body["transitPreferences"] = {
      allowedTravelModes: ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"],
    };
  }

  if (params.departureTime) {
    body["departureTime"] = new Date(
      parseInt(params.departureTime, 10) * 1000
    ).toISOString();
  }

  return body;
}
