import * as https from "https";
import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest, Request } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { Response } from "express";
import { initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";

import { toLegacyAutocomplete, toLegacyDetails } from "./places-transform";
import { checkRateLimit, WALK_RATE_LIMIT } from "./rate-limiter";
import { logAppCheckDenied, logRequestOutcome } from "./metrics";

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
//
// maxInstances（issue #160）: 既定ではインスタンスが実質無制限にスケールするため、
// 悪意あるトラフィックや予期しない急増時に課金が暴発し得る。全ハンドラ共通の安全弁
// として上限を設ける。値は各関数ごとの上限（4 関数 × 10 = 最大 40 インスタンス）で、
// レート制限（ADR-001）の後段に位置する二重の課金ガード。実測トラフィックを見て調整
// する前提の保守的な初期値。
setGlobalOptions({ region: "asia-northeast1", maxInstances: 10 });

const mapsKeySecret = defineSecret("GOOGLE_MAPS_API_KEY");
const navitimeKeySecret = defineSecret("NAVITIME_RAPIDAPI_KEY");
// レート制限のドキュメント ID を不可逆化する HMAC 鍵（#263）。rate-limiter が
// process.env 経由で読むため、各エンドポイントの secrets 配列へバインドして注入する。
const rateLimitHmacKeySecret = defineSecret("RATE_LIMIT_HMAC_KEY");

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

// Google Places API (New)。autocomplete は候補（placeId＋テキスト）のみ返し
// 座標は含まないため、確定時に details で location を引く2段フローにする。
const PLACES_AUTOCOMPLETE_NEW_URL =
  "https://places.googleapis.com/v1/places:autocomplete";
const PLACES_DETAILS_NEW_BASE = "https://places.googleapis.com/v1/places";
// locationBias の円半径（メートル）。Places API の許容上限は 50000m。
// 現在地を中心にこの円内を優先（soft bias）し、近隣 POI を上位へ寄せる。
const PLACES_BIAS_RADIUS_M = 50000;

// Google Routes API。徒歩ルートの街路追従ジオメトリ（encodedPolyline）と
// 距離・所要時間を返す。NAVITIME が徒歩 shape を返さないため徒歩線はここから得る。
const ROUTES_COMPUTE_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";
// 課金は FieldMask で要求したフィールドに依存する。徒歩線・距離・時間のみ取得。
const ROUTES_FIELD_MASK =
  "routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration";

// Google Routes API computeRouteMatrix。origins × destinations の各レッグを
// 一括実測する（#118 の予算境界帯の実測）。polyline は返さず所要時間・距離のみ。
const ROUTES_MATRIX_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
// マトリクスは要素ごとに index/所要/距離だけ取得する。index が無いと結果を
// origin/destination へ対応付けられないため FieldMask に必須で含める。
const ROUTES_MATRIX_FIELD_MASK =
  "originIndex,destinationIndex,duration,distanceMeters";
// computeRouteMatrix は要素数（origins × destinations）課金。クライアント不具合や
// 悪用での課金暴発を防ぐため、プロキシ側でも要素数上限を強制する（ADR-001 のレート
// 制御方針と整合）。#118 の設計は片側 ≤10・他方 1 の最大 10 要素のため、グリッド状の
// 大量要求を弾きつつ正常系に十分な余裕を持たせた値にする。
export const MATRIX_MAX_ELEMENTS = 25;

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

/**
 * セミコロン区切りの "lat,lng" 列を waypoint 座標配列へ変換する（#118 マトリクス用）。
 * いずれか 1 点でも不正なら全体を null（部分的に欠けた要素対応は誤対応の元のため）。
 * 空文字・undefined も null。
 */
export function parseLatLngList(
  value: string | undefined
): { latitude: number; longitude: number }[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const out: { latitude: number; longitude: number }[] = [];
  for (const part of value.split(";")) {
    const point = parseLatLng(part);
    if (!point) return null;
    out.push(point);
  }
  return out.length > 0 ? out : null;
}

/** computeRouteMatrix の要素数（origins × destinations）。課金単位。 */
export function matrixElementCount(
  originCount: number,
  destinationCount: number
): number {
  return originCount * destinationCount;
}

/** Routes API computeRouteMatrix（徒歩）のリクエストボディを生成する。 */
export function buildRoutesMatrixBody(
  origins: { latitude: number; longitude: number }[],
  destinations: { latitude: number; longitude: number }[]
): string {
  return JSON.stringify({
    origins: origins.map((latLng) => ({
      waypoint: { location: { latLng } },
    })),
    destinations: destinations.map((latLng) => ({
      waypoint: { location: { latLng } },
    })),
    travelMode: "WALK",
  });
}

// レート制限のキーに使うクライアント IP を返す（issue #151）。
//
// なぜ req.ip を使わないか：
//   gen2 (Cloud Run) の実行基盤である functions-framework は起動時に
//   `app.enable('trust proxy')`（= trust proxy = true / 全プロキシ信頼）を
//   呼ぶ。この設定下で Express の req.ip は X-Forwarded-For の *最左端* を返す。
//   最左端はクライアントが自由に prepend できる値なので、req.ip をキーにすると
//   攻撃者が毎リクエスト別の先頭値を送るだけで IP 単位のレート制限を回避できる。
//
// 正しい信頼境界：
//   クライアントが送る XFF 値は必ずヘッダの左側に積まれ、Google インフラは
//   実接続元 IP をヘッダの *右端* に追記する。攻撃者は右端より後ろに値を
//   足せないため、「右から数えた位置」は常にインフラ制御であり偽装不可能。
//   そこで req.ip ではなく XFF を自前パースし、右から TRUSTED_PROXY_HOPS 番目を
//   採用する。Firebase Functions gen2 の直アクセス（外部 LB 無し）では基盤が
//   実 IP を最後の 1 要素として追記するため右端（=1）で実クライアントに一致する。
//
// フェイルクローズ性：
//   仮にホップ数が想定とずれても「右から数える」限り攻撃者制御値には決して
//   到達せず、最悪でも定数 IP に丸まって全員が同一バケットで過剰制限されるだけ。
//   バイパスは構造的に起きない。XFF が無い場合（ローカル/エミュレータ等）のみ、
//   偽装される余地の無い req.ip（この分岐では実ソケット peer に等しい）へ戻す。
const TRUSTED_PROXY_HOPS = 1;

export function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const chain = typeof fwd === "string"
    ? fwd.split(",")
    : Array.isArray(fwd)
      ? fwd.flatMap((v) => v.split(","))
      : [];
  const trusted = chain.map((s) => s.trim()).filter((s) => s.length > 0);
  if (trusted.length >= TRUSTED_PROXY_HOPS) {
    return trusted[trusted.length - TRUSTED_PROXY_HOPS];
  }
  return req.ip ?? "unknown";
}

// Firebase App Check verification for raw HTTP functions. onRequest (unlike
// onCall) has no built-in enforceAppCheck, so the X-Firebase-AppCheck header
// must be verified explicitly. Without a valid token the request is rejected
// with 401, blocking unauthenticated access to these billable proxies.
// The emulator is exempted so local development works without App Check setup.
//
// リプレイ保護（issue #155）:
//   opts.consume=true のとき verifyToken に { consume: true } を渡し、App Check
//   バックエンドにトークンを「消費済み」として記録させる。クライアントは
//   getLimitedUseToken() で毎回新規トークンを送る前提で、2 回目以降は応答の
//   alreadyConsumed=true で返るためリプレイとして 401 で弾く。追加往復のコストが
//   あるため、要素数課金の googleWalkMatrixProxy のような高単価エンドポイント
//   限定で有効化する。consume 未指定時は従来通り単一引数で検証する（他プロキシは
//   キャッシュ済み標準トークンを再利用でき、動作・コストとも不変）。
export async function verifyAppCheck(
  req: Request,
  res: Response,
  opts: { consume?: boolean; endpoint?: string } = {}
): Promise<boolean> {
  if (process.env.FUNCTIONS_EMULATOR === "true") return true;
  const endpoint = opts.endpoint ?? "unknown";
  const token = req.header("X-Firebase-AppCheck");
  if (!token) {
    console.warn("AppCheck: token missing");
    logAppCheckDenied({ endpoint, reason: "missing" });
    res.status(401).json({ error: "App Check token missing" });
    return false;
  }
  try {
    const result = opts.consume
      ? await getAppCheck().verifyToken(token, { consume: true })
      : await getAppCheck().verifyToken(token);
    if (opts.consume && result.alreadyConsumed) {
      console.warn("AppCheck: token already consumed (replay)");
      logAppCheckDenied({ endpoint, reason: "replayed" });
      res.status(401).json({ error: "App Check token already consumed" });
      return false;
    }
    return true;
  } catch (e) {
    console.warn("AppCheck: token invalid", e);
    logAppCheckDenied({ endpoint, reason: "invalid" });
    res.status(401).json({ error: "App Check token invalid" });
    return false;
  }
}

// 上流 API 呼び出しの信頼性ガード（issue #157）。無応答の上流に対して Function
// インスタンスを課金枠（gen2 既定 60s）まで張り付かせないよう、十分手前で打ち切る。
const UPSTREAM_TIMEOUT_MS = 10_000;

// 受信レスポンスの累積バイト上限。想定外に巨大な応答でメモリを圧迫しないよう、
// 超過時点で接続を破棄する。上流（Places/Routes/NAVITIME）の正常応答は数百KB
// 程度のため、正常系に十分な余裕を持たせた値にする。
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

// requestJsonNew の失敗種別。呼び出し側で 504（timeout）と 502（その他上流障害）を
// 区別するために用いる。
type UpstreamErrorKind = "timeout" | "too_large" | "network" | "parse";

class UpstreamError extends Error {
  constructor(message: string, readonly kind: UpstreamErrorKind) {
    super(message);
    this.name = "UpstreamError";
  }
}

// 上流失敗時に res へ 504/502 を書いたことを示すセンチネル。呼び出し側は
// これが返ったら（レスポンス送信済みのため）即 return する。JSON の null と
// 衝突しないよう Symbol を使う。
const UPSTREAM_FAILED = Symbol("upstream_failed");

// Places API (New) 用。エラー時も JSON ボディ（{error:...}）を返すため
// ステータスコードに関わらずパースして呼び出し側（変換層）へ渡す。
// タイムアウト時は timeout イベントで接続を破棄し UpstreamError で reject する
// （https は timeout オプションだけでは接続を閉じないため明示 destroy が必要）。
function requestJsonNew(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method, headers, timeout: UPSTREAM_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            // 上限超過。以降のボディを貯めず接続ごと破棄する。
            req.destroy(new UpstreamError("response too large", "too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            reject(new UpstreamError("invalid JSON from upstream", "parse"));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new UpstreamError("upstream request timed out", "timeout"));
    });
    req.on("error", (err) => {
      reject(
        err instanceof UpstreamError
          ? err
          : new UpstreamError(err.message, "network")
      );
    });
    if (body) req.write(body);
    req.end();
  });
}

// requestJsonNew を呼び、タイムアウト/上流障害を 504/502 に変換して res へ書く。
// 成功時はパース済みボディを返し、失敗時は res 応答済みで UPSTREAM_FAILED を返す。
// 併せて成否・レイテンシ・上流ステータスを構造化ログへ記録する（issue #268）。
// 上流が 2xx でも意味的に失敗（items/routes 欠落・非配列等）なケースがあるため、
// 成功ログは validate（呼び出し側と同じボディ述語）を通した後に出す。HTTP 成功で
// 記録してしまうと、まさに検出したいクォータ/認証/スキーマ失敗が SLO 上の成功に
// 化ける。validate NG は httpStatus をそのまま（通常 200）に semanticFailure=true で
// failure として記録し、502 化は従来どおり呼び出し側に任せる（1リクエスト1ログ）。
async function fetchUpstream(
  res: Response,
  endpoint: string,
  upstream: string,
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: string,
  validate?: (data: unknown) => boolean
): Promise<unknown> {
  const start = Date.now();
  try {
    const { statusCode, data } = await requestJsonNew(url, method, headers, body);
    // 一次判定はステータスコード。上流が 4xx/5xx を返したら成否をボディ形状から
    // 推測せず 502（Bad Gateway）へ寄せ、上流ボディをそのまま返す（呼び出し側の
    // ボディ判定は 200 でエラーボディを返す稀ケースの保険として残す）。
    if (statusCode < 200 || statusCode >= 300) {
      console.error(`[${endpoint}] upstream status ${statusCode}:`, JSON.stringify(data));
      logRequestOutcome({
        endpoint,
        upstream,
        status: "failure",
        latencyMs: Date.now() - start,
        httpStatus: statusCode,
      });
      res.status(502).json(data);
      return UPSTREAM_FAILED;
    }
    const semanticallyValid = validate ? validate(data) : true;
    logRequestOutcome({
      endpoint,
      upstream,
      status: semanticallyValid ? "success" : "failure",
      latencyMs: Date.now() - start,
      httpStatus: statusCode,
      ...(semanticallyValid ? {} : { semanticFailure: true }),
    });
    return data;
  } catch (e) {
    const timedOut = e instanceof UpstreamError && e.kind === "timeout";
    console.error(`[${endpoint}] upstream ${timedOut ? "timeout" : "error"}:`, e);
    logRequestOutcome({
      endpoint,
      upstream,
      status: "failure",
      latencyMs: Date.now() - start,
      httpStatus: timedOut ? 504 : undefined,
    });
    res
      .status(timedOut ? 504 : 502)
      .json({ error: timedOut ? "upstream timeout" : "upstream error" });
    return UPSTREAM_FAILED;
  }
}

// 上流 2xx 応答のボディが「意味的な成功」かを判定する述語群。fetchUpstream の
// 成否ログ（validate）と呼び出し側の 502 変換の両方で同じ関数を使う。別々に
// 書くと判定が乖離し「ログは成功・クライアントには 502」が再発し得るため、
// 述語を1箇所に共有して構造的に防ぐ。

// RapidAPI/NAVITIME はエラー時に items を含まず {message:...} 等を返す。
function isNavitimeSuccessBody(data: unknown): boolean {
  const record = data as Record<string, unknown> | null;
  return !(record && record["message"] && !record["items"]);
}

// Routes API はエラー時 {error:{...}} を返し routes を含まない。
function isRoutesWalkSuccessBody(data: unknown): boolean {
  const record = data as Record<string, unknown> | null;
  return !(record && record["error"] && !record["routes"]);
}

// computeRouteMatrix は成功時に要素オブジェクトの配列を返す。
function isRoutesMatrixSuccessBody(data: unknown): boolean {
  return Array.isArray(data);
}

// CORS is set to * because clients are Flutter mobile apps which are not subject
// to browser CORS restrictions. Unauthorized access is prevented by Firebase
// App Check: every handler calls verifyAppCheck() to validate the
// X-Firebase-AppCheck token before doing any billable work.

/**
 * クエリの lat/lon を数値として取り出す。両方が有限値のときだけ
 * { latitude, longitude } を返し、欠落・不正なら undefined。
 */
function parseLatLon(
  query: Record<string, string | undefined>
): { latitude: number; longitude: number } | undefined {
  const lat = Number(query["lat"]);
  const lon = Number(query["lon"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { latitude: lat, longitude: lon };
}

/**
 * 現在地から locationBias（円）を組み立てる。lat/lon が数値として揃っている
 * ときだけ円バイアスを返し、欠落・不正なら undefined（バイアスなし）。
 * radius は任意（既定 PLACES_BIAS_RADIUS_M）で 0 < r <= 50000 にクランプする。
 */
function buildLocationBias(
  query: Record<string, string | undefined>
): { circle: { center: { latitude: number; longitude: number }; radius: number } } | undefined {
  const center = parseLatLon(query);
  if (!center) return undefined;

  const requested = Number(query["radius"]);
  const radius = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, PLACES_BIAS_RADIUS_M)
    : PLACES_BIAS_RADIUS_M;

  return { circle: { center, radius } };
}

/** Places Autocomplete / Details プロキシ */
export const placesProxy = onRequest({ secrets: [mapsKeySecret, rateLimitHmacKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck");
    res.status(204).send("");
    return;
  }

  if (!(await verifyAppCheck(req, res, { endpoint: "placesProxy" }))) return;

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

    // 現在地（lat/lon）が渡されていれば locationBias（円）で近隣を優先する。
    // これが #144 の主目的：位置バイアスで「近い順」の候補を返す。
    const locationBias = buildLocationBias(
      req.query as Record<string, string | undefined>
    );
    // 同じ現在地を origin としても渡し、各候補に distanceMeters を付ける（#146 C案）。
    // クライアントはこの距離で候補を距離昇順へ再ソートできる（typeahead を壊さない）。
    const origin = parseLatLon(
      req.query as Record<string, string | undefined>
    );

    const data = await fetchUpstream(
      res,
      "placesProxy.autocomplete",
      "places",
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
        ...(locationBias ? { locationBias } : {}),
        ...(origin ? { origin } : {}),
      })
    );
    if (data === UPSTREAM_FAILED) return;
    res.json(toLegacyAutocomplete(data));
    return;
  }

  if (action === "details") {
    const placeId = req.query["place_id"] as string | undefined;
    if (!placeId) {
      res.status(400).json({ error: "place_id is required" });
      return;
    }
    const data = await fetchUpstream(
      res,
      "placesProxy.details",
      "places",
      `${PLACES_DETAILS_NEW_BASE}/${encodeURIComponent(placeId)}`,
      "GET",
      {
        "X-Goog-Api-Key": getMapsApiKey(),
        "X-Goog-FieldMask": "location",
      }
    );
    if (data === UPSTREAM_FAILED) return;
    res.json(toLegacyDetails(data));
    return;
  }

  res.status(400).json({ error: "action must be autocomplete or details" });
});

/** NAVITIME route_transit プロキシ（RapidAPI 経由、レスポンスは無加工で返す） */
export const navitimeProxy = onRequest({ secrets: [navitimeKeySecret, rateLimitHmacKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck");
    res.status(204).send("");
    return;
  }

  if (!(await verifyAppCheck(req, res, { endpoint: "navitimeProxy" }))) return;

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

  const data = await fetchUpstream(
    res,
    "navitimeProxy",
    "navitime",
    buildNavitimeUrl(req.query as Record<string, string | undefined>),
    "GET",
    {
      "X-RapidAPI-Key": getNavitimeApiKey(),
      "X-RapidAPI-Host": NAVITIME_HOST,
    },
    undefined,
    isNavitimeSuccessBody
  );
  if (data === UPSTREAM_FAILED) return;

  // 認証エラー・クォータ超過と「ルートなし」を区別するため 502 で返す。
  if (!isNavitimeSuccessBody(data)) {
    console.error(
      "[navitimeProxy] NAVITIME API error:",
      JSON.stringify((data as Record<string, unknown>)["message"])
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
export const googleWalkProxy = onRequest({ secrets: [mapsKeySecret, rateLimitHmacKeySecret] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck");
    res.status(204).send("");
    return;
  }

  if (!(await verifyAppCheck(req, res, { endpoint: "googleWalkProxy" }))) return;

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

  const data = await fetchUpstream(
    res,
    "googleWalkProxy",
    "routes-walk",
    ROUTES_COMPUTE_URL,
    "POST",
    {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getMapsApiKey(),
      "X-Goog-FieldMask": ROUTES_FIELD_MASK,
    },
    buildRoutesWalkBody(start, goal),
    isRoutesWalkSuccessBody
  );
  if (data === UPSTREAM_FAILED) return;

  // 認証・クォータ等の失敗を「ルートなし」と区別するため 502 で返す。
  if (!isRoutesWalkSuccessBody(data)) {
    console.error(
      "[googleWalkProxy] Routes API error:",
      JSON.stringify((data as Record<string, unknown>)["error"])
    );
    res.status(502).json(data);
    return;
  }

  res.json(data);
});

/**
 * Google Routes 徒歩マトリクスプロキシ（#118）。origins/destinations（"lat,lng" を
 * セミコロン区切りした列）から computeRouteMatrix を travelMode=WALK で叩き、
 * 各レッグの originIndex/destinationIndex/duration/distanceMeters を返す（polyline は
 * 返さない）。予算境界帯の候補レッグを一括実測し、帯内を実測値で比較するために使う。
 * 要素数（origins × destinations）課金のため、上限超過は上流を呼ばず 400 で拒否する。
 * レスポンスは無加工で返す（変換はクライアント側）。
 */
export const googleWalkMatrixProxy = onRequest(
  { secrets: [mapsKeySecret, rateLimitHmacKeySecret] },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET");
      res.set("Access-Control-Allow-Headers", "Content-Type, X-Firebase-AppCheck");
      res.status(204).send("");
      return;
    }

    // 要素数課金で最も高単価なため、リプレイ保護（limited-use token 消費）を
    // このエンドポイントに限定して有効化する（issue #155）。
    if (
      !(await verifyAppCheck(req, res, {
        consume: true,
        endpoint: "googleWalkMatrixProxy",
      }))
    )
      return;

    if (!(await checkRateLimit(clientIp(req), WALK_RATE_LIMIT))) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    const origins = parseLatLngList(req.query["origins"] as string | undefined);
    const destinations = parseLatLngList(
      req.query["destinations"] as string | undefined
    );

    if (!origins || !destinations) {
      res.status(400).json({
        error:
          "origins and destinations are required as ';'-separated 'lat,lng'",
      });
      return;
    }

    // 要素数上限の強制（課金暴発・悪用の防止）。上流を呼ぶ前に弾く。
    const elements = matrixElementCount(origins.length, destinations.length);
    if (elements > MATRIX_MAX_ELEMENTS) {
      res.status(400).json({
        error: `too many elements: ${elements} > ${MATRIX_MAX_ELEMENTS}`,
      });
      return;
    }

    const data = await fetchUpstream(
      res,
      "googleWalkMatrixProxy",
      "routes-matrix",
      ROUTES_MATRIX_URL,
      "POST",
      {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getMapsApiKey(),
        "X-Goog-FieldMask": ROUTES_MATRIX_FIELD_MASK,
      },
      buildRoutesMatrixBody(origins, destinations),
      isRoutesMatrixSuccessBody
    );
    if (data === UPSTREAM_FAILED) return;

    // 配列でなければ正常な結果ではない（エラー時は {error:{...}}、それ以外も想定外
    // 応答）。認証・クォータ等の失敗を「結果なし」と区別し、想定外応答もまとめて
    // 502 で返す（「成功＝配列」の不変条件をプロキシ側でも担保し、クライアントへ
    // 非配列の 200 を漏らさない）。
    if (!isRoutesMatrixSuccessBody(data)) {
      const record = data as Record<string, unknown> | null;
      console.error(
        "[googleWalkMatrixProxy] Routes API non-array response:",
        JSON.stringify(record && record["error"] ? record["error"] : data)
      );
      res.status(502).json(data);
      return;
    }

    res.json(data);
  }
);
