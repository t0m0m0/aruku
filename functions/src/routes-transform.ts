// Routes API (New) のレスポンスを、Flutter クライアントが期待する
// レガシー Directions API 形式へ変換する純粋関数群。
// プロキシを変換層にすることでクライアント側の改修を不要にする。

export interface LegacyTransitDetails {
  departure_stop: { name: string };
  arrival_stop: { name: string };
  line: { name: string };
  num_stops: number;
}

export interface LegacyStep {
  travel_mode: string;
  distance: { value: number };
  duration: { value: number };
  polyline: { points: string };
  transit_details?: LegacyTransitDetails;
}

// Routes API はレッグにアドレスを返さない（座標のみ）。
// start_address/end_address は省略し、クライアント側の
// '出発地'/'目的地' フォールバック（`as String? ?? ...`）に委ねる。
export interface LegacyLeg {
  start_address?: string;
  end_address?: string;
  steps: LegacyStep[];
}

export interface LegacyRoute {
  legs: LegacyLeg[];
}

export interface LegacyDirectionsResponse {
  status: string;
  routes: LegacyRoute[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseDurationSeconds(s: unknown): number {
  if (typeof s !== "string") return 0;
  const m = s.match(/^(\d+)s$/);
  return m ? parseInt(m[1], 10) : 0;
}

export function toLegacyTravelMode(mode: unknown): string {
  if (mode === "WALK") return "WALKING";
  return typeof mode === "string" ? mode : "WALKING";
}

function toLegacyStep(raw: unknown): LegacyStep | null {
  const step = asRecord(raw);
  if (!step) return null;

  const distanceMeters =
    typeof step["distanceMeters"] === "number" ? step["distanceMeters"] : 0;
  const staticDuration = parseDurationSeconds(step["staticDuration"]);
  const polyline = asRecord(step["polyline"]);
  const encodedPolyline =
    typeof polyline?.["encodedPolyline"] === "string"
      ? (polyline["encodedPolyline"] as string)
      : "";
  const travelMode = toLegacyTravelMode(step["travelMode"]);

  const result: LegacyStep = {
    travel_mode: travelMode,
    distance: { value: distanceMeters },
    duration: { value: staticDuration },
    polyline: { points: encodedPolyline },
  };

  if (step["travelMode"] === "TRANSIT") {
    const td = asRecord(step["transitDetails"]);
    const stopDetails = asRecord(td?.["stopDetails"]);
    const depStop = asRecord(stopDetails?.["departureStop"]);
    const arrStop = asRecord(stopDetails?.["arrivalStop"]);
    const transitLine = asRecord(td?.["transitLine"]);
    const stopCount = td?.["stopCount"];

    result.transit_details = {
      departure_stop: {
        name: typeof depStop?.["name"] === "string" ? depStop["name"] : "",
      },
      arrival_stop: {
        name: typeof arrStop?.["name"] === "string" ? arrStop["name"] : "",
      },
      line: {
        name:
          typeof transitLine?.["name"] === "string"
            ? transitLine["name"]
            : "",
      },
      num_stops: typeof stopCount === "number" ? stopCount : 0,
    };
  }

  return result;
}

function toLegacyLeg(raw: unknown): LegacyLeg | null {
  const leg = asRecord(raw);
  if (!leg) return null;

  const steps: LegacyStep[] = [];
  if (Array.isArray(leg["steps"])) {
    for (const s of leg["steps"]) {
      const step = toLegacyStep(s);
      if (step) steps.push(step);
    }
  }

  const result: LegacyLeg = { steps };
  if (typeof leg["startAddress"] === "string") {
    result.start_address = leg["startAddress"];
  }
  if (typeof leg["endAddress"] === "string") {
    result.end_address = leg["endAddress"];
  }
  return result;
}

function toLegacyRoute(raw: unknown): LegacyRoute | null {
  const route = asRecord(raw);
  if (!route) return null;

  const rawLegs = route["legs"];
  if (!Array.isArray(rawLegs) || rawLegs.length === 0) return null;

  const leg = toLegacyLeg(rawLegs[0]);
  if (!leg) return null;

  return { legs: [leg] };
}

export function toLegacyDirections(raw: unknown): LegacyDirectionsResponse {
  const body = asRecord(raw);
  if (!body) return { status: "UNKNOWN_ERROR", routes: [] };
  if (body["error"]) return { status: "REQUEST_DENIED", routes: [] };

  const rawRoutes = body["routes"];
  if (!Array.isArray(rawRoutes) || rawRoutes.length === 0) {
    return { status: "ZERO_RESULTS", routes: [] };
  }

  const routes: LegacyRoute[] = [];
  for (const r of rawRoutes) {
    const route = toLegacyRoute(r);
    if (route) routes.push(route);
  }

  if (routes.length === 0) return { status: "ZERO_RESULTS", routes: [] };
  return { status: "OK", routes };
}
