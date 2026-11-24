import * as https from 'https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest, Request } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { Response } from 'express';
import { initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getStorage } from 'firebase-admin/storage';

import { asRecord, isRecord } from './json';
import { toLegacyAutocomplete, toLegacyDetails } from './places-transform';
import { checkRateLimit, RATE_LIMIT, WALK_RATE_LIMIT } from './rate-limiter';
import {
  logAppCheckDenied,
  logExactWalkMax,
  logRequestLatency,
  logRequestOutcome,
  logRideDeparture,
} from './metrics';
import { createUpstreamCache } from './upstream-cache';
import { refreshTimetablePacks as refreshPacks } from './timetable-pack/refresh';
import { createScanDaySource } from './timetable-pack/load';
import {
  findExactWalkMax,
  parseExactWalkMaxQuery,
  type ScanStage,
  type MatrixElement,
} from './exact-walk-max';
import { parseRideDepartureQuery, resolveRideDeparture } from './ride-departures';
import type { LatLng } from './exact-scan';

export {
  checkRateLimit,
  checkRateLimitInMemory,
  checkRateLimitFirestore,
  resetRateLimit,
  rateLimitMapSize,
  RATE_LIMIT,
  WALK_RATE_LIMIT,
} from './rate-limiter';

initializeApp();

setGlobalOptions({ region: 'asia-northeast1', maxInstances: 10 });

const mapsKeySecret = defineSecret('GOOGLE_MAPS_API_KEY');
const rateLimitHmacKeySecret = defineSecret('RATE_LIMIT_HMAC_KEY');

function getMapsApiKey(): string {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    return process.env.GOOGLE_MAPS_API_KEY ?? '';
  }
  return mapsKeySecret.value();
}

const PLACES_AUTOCOMPLETE_NEW_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACES_DETAILS_NEW_BASE = 'https://places.googleapis.com/v1/places';
const PLACES_BIAS_RADIUS_M = 50000;

const ROUTES_COMPUTE_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTES_FIELD_MASK = 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration';

const ROUTES_MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const ROUTES_MATRIX_FIELD_MASK = 'originIndex,destinationIndex,duration,distanceMeters';
export const MATRIX_MAX_ELEMENTS = 25;

function queryParam(query: Record<string, unknown>, name: string): string | undefined {
  const value = query[name];
  return typeof value === 'string' ? value : undefined;
}

function parseLatLng(value: string | undefined): { latitude: number; longitude: number } | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

export function buildRoutesWalkBody(
  start: { latitude: number; longitude: number },
  goal: { latitude: number; longitude: number },
): string {
  return JSON.stringify({
    origin: { location: { latLng: start } },
    destination: { location: { latLng: goal } },
    travelMode: 'WALK',
  });
}

export function parseLatLngList(
  value: string | undefined,
): { latitude: number; longitude: number }[] | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const out: { latitude: number; longitude: number }[] = [];
  for (const part of value.split(';')) {
    const point = parseLatLng(part);
    if (!point) return null;
    out.push(point);
  }
  return out.length > 0 ? out : null;
}

export function matrixElementCount(originCount: number, destinationCount: number): number {
  return originCount * destinationCount;
}

export function buildRoutesMatrixBody(
  origins: { latitude: number; longitude: number }[],
  destinations: { latitude: number; longitude: number }[],
): string {
  return JSON.stringify({
    origins: origins.map((latLng) => ({
      waypoint: { location: { latLng } },
    })),
    destinations: destinations.map((latLng) => ({
      waypoint: { location: { latLng } },
    })),
    travelMode: 'WALK',
  });
}

const COORD_KEY_DECIMALS = 5;

function roundCoordKey(n: number): number {
  const factor = 10 ** COORD_KEY_DECIMALS;
  return Math.round(n * factor) / factor;
}

function coordKey(p: { latitude: number; longitude: number }): string {
  return `${roundCoordKey(p.latitude)},${roundCoordKey(p.longitude)}`;
}

function walkCacheKey(
  start: { latitude: number; longitude: number },
  goal: { latitude: number; longitude: number },
): string {
  return `routes-walk:${coordKey(start)};${coordKey(goal)}`;
}

function matrixCacheKey(
  origins: { latitude: number; longitude: number }[],
  destinations: { latitude: number; longitude: number }[],
): string {
  return `routes-matrix:${origins.map(coordKey).join(';')}|${destinations.map(coordKey).join(';')}`;
}

const TRUSTED_PROXY_HOPS = 1;

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const chain =
    typeof fwd === 'string'
      ? fwd.split(',')
      : Array.isArray(fwd)
        ? fwd.flatMap((v) => v.split(','))
        : [];
  const trusted = chain.map((s) => s.trim()).filter((s) => s.length > 0);
  if (trusted.length >= TRUSTED_PROXY_HOPS) {
    return trusted[trusted.length - TRUSTED_PROXY_HOPS];
  }
  return req.ip ?? 'unknown';
}

const DEFAULT_APP_CHECK_CONSUME_ENDPOINTS = [
  'placesProxy',
  'googleWalkMatrixProxy',
  'exactWalkMax',
  'rideDepartures',
];

export function shouldConsumeAppCheckToken(endpoint: string): boolean {
  const configured = process.env.APP_CHECK_CONSUME_ENDPOINTS;
  const endpoints =
    configured === undefined
      ? DEFAULT_APP_CHECK_CONSUME_ENDPOINTS
      : configured
          .split(',')
          .map((e) => e.trim())
          .filter((e) => e.length > 0);
  return endpoints.includes(endpoint);
}

const appCheckMsByRes = new WeakMap<object, number>();

export async function verifyAppCheck(
  req: Request,
  res: Response,
  opts: { endpoint?: string } = {},
): Promise<boolean> {
  if (process.env.FUNCTIONS_EMULATOR === 'true') return true;
  const endpoint = opts.endpoint ?? 'unknown';
  const consume = shouldConsumeAppCheckToken(endpoint);
  const token = req.header('X-Firebase-AppCheck');
  if (token === undefined || token === '') {
    console.warn('AppCheck: token missing');
    logAppCheckDenied({ endpoint, reason: 'missing' });
    res.status(401).json({ error: 'App Check token missing' });
    return false;
  }
  const start = Date.now();
  try {
    const result = consume
      ? await getAppCheck().verifyToken(token, { consume: true })
      : await getAppCheck().verifyToken(token);
    if (consume && result.alreadyConsumed === true) {
      console.warn('AppCheck: token already consumed (replay)');
      logAppCheckDenied({ endpoint, reason: 'replayed' });
      res.status(401).json({ error: 'App Check token already consumed' });
      return false;
    }
    return true;
  } catch (e) {
    console.warn('AppCheck: token invalid', e);
    logAppCheckDenied({ endpoint, reason: 'invalid' });
    res.status(401).json({ error: 'App Check token invalid' });
    return false;
  } finally {
    appCheckMsByRes.set(res, Date.now() - start);
  }
}

const UPSTREAM_TIMEOUT_MS = 10_000;

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type UpstreamErrorKind = 'timeout' | 'too_large' | 'network' | 'parse' | 'status';

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly kind: UpstreamErrorKind,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const UPSTREAM_FAILED = Symbol('upstream_failed');

const upstreamAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  timeout: 5_000,
});

function requestJsonNew(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string,
): Promise<{ statusCode: number; data: unknown }> {
  return attemptRequestJsonNew(url, method, headers, body, false);
}

function attemptRequestJsonNew(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: string | undefined,
  isRetry: boolean,
): Promise<{ statusCode: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method, headers, timeout: UPSTREAM_TIMEOUT_MS, agent: upstreamAgent },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy(new UpstreamError('response too large', 'too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          let data: unknown;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(new UpstreamError('invalid JSON from upstream', 'parse'));
            return;
          }
          resolve({ statusCode: res.statusCode ?? 0, data });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new UpstreamError('upstream request timed out', 'timeout'));
    });
    req.on('error', (err) => {
      const canRetryStaleSocket =
        !isRetry && method === 'GET' && req.reusedSocket && !(err instanceof UpstreamError);
      if (canRetryStaleSocket) {
        resolve(attemptRequestJsonNew(url, method, headers, body, true));
        return;
      }
      reject(err instanceof UpstreamError ? err : new UpstreamError(err.message, 'network'));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function fetchUpstream(
  res: Response,
  endpoint: string,
  upstream: string,
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string,
  validate?: (data: unknown) => boolean,
  cacheKey?: string,
): Promise<unknown> {
  try {
    const { statusCode, data } = await callUpstream(
      endpoint,
      upstream,
      url,
      method,
      headers,
      body,
      validate,
      cacheKey,
    );
    if (statusCode < 200 || statusCode >= 300) {
      res.status(502).json(data);
      return UPSTREAM_FAILED;
    }
    return data;
  } catch (e) {
    const timedOut = e instanceof UpstreamError && e.kind === 'timeout';
    res
      .status(timedOut ? 504 : 502)
      .json({ error: timedOut ? 'upstream timeout' : 'upstream error' });
    return UPSTREAM_FAILED;
  }
}

interface UpstreamResult {
  statusCode: number;
  data: unknown;
}

const upstreamCache = createUpstreamCache<UpstreamResult>();

export function resetUpstreamCache(): void {
  upstreamCache.reset();
}

async function callUpstream(
  endpoint: string,
  upstream: string,
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string,
  validate?: (data: unknown) => boolean,
  cacheKey?: string,
): Promise<{ statusCode: number; data: unknown }> {
  const call = async (): Promise<{ statusCode: number; data: unknown }> => {
    const start = Date.now();
    try {
      const { statusCode, data } = await requestJsonNew(url, method, headers, body);
      if (statusCode < 200 || statusCode >= 300) {
        console.error(`[${endpoint}] upstream status ${statusCode}:`, JSON.stringify(data));
        logRequestOutcome({
          endpoint,
          upstream,
          status: 'failure',
          latencyMs: Date.now() - start,
          httpStatus: statusCode,
        });
      } else {
        const semanticallyValid = validate ? validate(data) : true;
        logRequestOutcome({
          endpoint,
          upstream,
          status: semanticallyValid ? 'success' : 'failure',
          latencyMs: Date.now() - start,
          httpStatus: statusCode,
          ...(semanticallyValid ? {} : { semanticFailure: true }),
        });
      }
      return { statusCode, data };
    } catch (e) {
      const timedOut = e instanceof UpstreamError && e.kind === 'timeout';
      console.error(`[${endpoint}] upstream ${timedOut ? 'timeout' : 'error'}:`, e);
      logRequestOutcome({
        endpoint,
        upstream,
        status: 'failure',
        latencyMs: Date.now() - start,
        httpStatus: timedOut ? 504 : undefined,
      });
      throw e;
    }
  };

  return cacheKey !== undefined
    ? upstreamCache.dedupe(cacheKey, call, isUpstreamCacheable(validate))
    : call();
}

function isUpstreamCacheable(
  validate: ((data: unknown) => boolean) | undefined,
): (result: { statusCode: number; data: unknown }) => boolean {
  return ({ statusCode, data }) =>
    statusCode >= 200 && statusCode < 300 && (validate ? validate(data) : true);
}

function isRoutesWalkSuccessBody(data: unknown): boolean {
  const record = asRecord(data);
  return record?.['error'] == null || record['routes'] != null;
}

function isRoutesMatrixSuccessBody(data: unknown): data is unknown[] {
  return Array.isArray(data);
}

const CORS_ALLOWED_HOST = 'aruku.pages.dev';
const CORS_ALLOWED_DEV_HOSTS = new Set(['localhost', '127.0.0.1']);
const CORS_PREFLIGHT_MAX_AGE_S = 3600;

export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (CORS_ALLOWED_DEV_HOSTS.has(url.hostname)) return true;
  if (url.protocol !== 'https:') return false;
  return url.hostname === CORS_ALLOWED_HOST || url.hostname.endsWith(`.${CORS_ALLOWED_HOST}`);
}

function handleCors(req: Request, res: Response): boolean {
  res.set('Vary', 'Origin');
  const origin = req.header('Origin');
  if (origin !== undefined && isAllowedOrigin(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }

  if (req.method !== 'OPTIONS') return false;

  res.set('Access-Control-Allow-Methods', 'GET');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Firebase-AppCheck');
  res.set('Access-Control-Max-Age', String(CORS_PREFLIGHT_MAX_AGE_S));
  res.status(204).send('');
  return true;
}

function parseLatLon(
  query: Record<string, unknown>,
): { latitude: number; longitude: number } | undefined {
  const lat = Number(queryParam(query, 'lat'));
  const lon = Number(queryParam(query, 'lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { latitude: lat, longitude: lon };
}

function buildLocationBias(
  query: Record<string, unknown>,
): { circle: { center: { latitude: number; longitude: number }; radius: number } } | undefined {
  const center = parseLatLon(query);
  if (!center) return undefined;

  const requested = Number(queryParam(query, 'radius'));
  const radius =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, PLACES_BIAS_RADIUS_M)
      : PLACES_BIAS_RADIUS_M;

  return { circle: { center, radius } };
}

type RawHandler = (req: Request, res: Response) => void | Promise<void>;

export function withRequestLatency(endpoint: string, handler: RawHandler): RawHandler {
  return async (req, res) => {
    const start = Date.now();
    let threw = false;
    try {
      await handler(req, res);
    } catch (e) {
      threw = true;
      throw e;
    } finally {
      if (req.method !== 'OPTIONS') {
        const written = typeof res.statusCode === 'number' ? res.statusCode : 200;
        const appCheckMs = appCheckMsByRes.get(res);
        appCheckMsByRes.delete(res);
        logRequestLatency({
          endpoint,
          totalLatencyMs: Date.now() - start,
          httpStatus: threw && written < 400 ? 500 : written,
          appCheckMs,
        });
      }
    }
  };
}

export const placesProxy = onRequest(
  { secrets: [mapsKeySecret, rateLimitHmacKeySecret] },
  withRequestLatency('placesProxy', async (req, res) => {
    if (handleCors(req, res)) return;

    if (!(await verifyAppCheck(req, res, { endpoint: 'placesProxy' }))) return;

    if (!(await checkRateLimit(clientIp(req)))) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const action = queryParam(req.query, 'action');

    if (action === 'autocomplete') {
      const input = queryParam(req.query, 'input');
      const language = queryParam(req.query, 'language') ?? 'ja';
      const components = queryParam(req.query, 'components') ?? 'country:jp';
      if (input === undefined || input === '') {
        res.status(400).json({ error: 'input is required' });
        return;
      }
      const regionCodes = components
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.startsWith('country:'))
        .map((c) => c.slice('country:'.length).toLowerCase())
        .filter((c) => c.length > 0);

      const locationBias = buildLocationBias(req.query);
      const origin = parseLatLon(req.query);

      const data = await fetchUpstream(
        res,
        'placesProxy.autocomplete',
        'places',
        PLACES_AUTOCOMPLETE_NEW_URL,
        'POST',
        {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': getMapsApiKey(),
        },
        JSON.stringify({
          input,
          languageCode: language,
          ...(regionCodes.length > 0 ? { includedRegionCodes: regionCodes } : {}),
          ...(locationBias ? { locationBias } : {}),
          ...(origin ? { origin } : {}),
        }),
      );
      if (data === UPSTREAM_FAILED) return;
      res.json(toLegacyAutocomplete(data));
      return;
    }

    if (action === 'details') {
      const placeId = queryParam(req.query, 'place_id');
      if (placeId === undefined || placeId === '') {
        res.status(400).json({ error: 'place_id is required' });
        return;
      }
      const data = await fetchUpstream(
        res,
        'placesProxy.details',
        'places',
        `${PLACES_DETAILS_NEW_BASE}/${encodeURIComponent(placeId)}`,
        'GET',
        {
          'X-Goog-Api-Key': getMapsApiKey(),
          'X-Goog-FieldMask': 'location',
        },
      );
      if (data === UPSTREAM_FAILED) return;
      res.json(toLegacyDetails(data));
      return;
    }

    res.status(400).json({ error: 'action must be autocomplete or details' });
  }),
);

export const googleWalkProxy = onRequest(
  { secrets: [mapsKeySecret, rateLimitHmacKeySecret] },
  withRequestLatency('googleWalkProxy', async (req, res) => {
    if (handleCors(req, res)) return;

    if (!(await verifyAppCheck(req, res, { endpoint: 'googleWalkProxy' }))) return;

    if (!(await checkRateLimit(clientIp(req), WALK_RATE_LIMIT))) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const start = parseLatLng(queryParam(req.query, 'start'));
    const goal = parseLatLng(queryParam(req.query, 'goal'));

    if (!start || !goal) {
      res.status(400).json({ error: "start and goal are required as 'lat,lng'" });
      return;
    }

    const data = await fetchUpstream(
      res,
      'googleWalkProxy',
      'routes-walk',
      ROUTES_COMPUTE_URL,
      'POST',
      {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': getMapsApiKey(),
        'X-Goog-FieldMask': ROUTES_FIELD_MASK,
      },
      buildRoutesWalkBody(start, goal),
      isRoutesWalkSuccessBody,
      walkCacheKey(start, goal),
    );
    if (data === UPSTREAM_FAILED) return;

    if (!isRoutesWalkSuccessBody(data)) {
      console.error(
        '[googleWalkProxy] Routes API error:',
        JSON.stringify(asRecord(data)?.['error']),
      );
      res.status(502).json(data);
      return;
    }

    res.json(data);
  }),
);

export const googleWalkMatrixProxy = onRequest(
  { secrets: [mapsKeySecret, rateLimitHmacKeySecret] },
  withRequestLatency('googleWalkMatrixProxy', async (req, res) => {
    if (handleCors(req, res)) return;

    if (!(await verifyAppCheck(req, res, { endpoint: 'googleWalkMatrixProxy' }))) return;

    if (!(await checkRateLimit(clientIp(req), WALK_RATE_LIMIT))) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const origins = parseLatLngList(queryParam(req.query, 'origins'));
    const destinations = parseLatLngList(queryParam(req.query, 'destinations'));

    if (!origins || !destinations) {
      res.status(400).json({
        error: "origins and destinations are required as ';'-separated 'lat,lng'",
      });
      return;
    }

    const elements = matrixElementCount(origins.length, destinations.length);
    if (elements > MATRIX_MAX_ELEMENTS) {
      res.status(400).json({
        error: `too many elements: ${elements} > ${MATRIX_MAX_ELEMENTS}`,
      });
      return;
    }

    const data = await fetchUpstream(
      res,
      'googleWalkMatrixProxy',
      'routes-matrix',
      ROUTES_MATRIX_URL,
      'POST',
      {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': getMapsApiKey(),
        'X-Goog-FieldMask': ROUTES_MATRIX_FIELD_MASK,
      },
      buildRoutesMatrixBody(origins, destinations),
      isRoutesMatrixSuccessBody,
      matrixCacheKey(origins, destinations),
    );
    if (data === UPSTREAM_FAILED) return;

    if (!isRoutesMatrixSuccessBody(data)) {
      const record = asRecord(data);
      console.error(
        '[googleWalkMatrixProxy] Routes API non-array response:',
        JSON.stringify(record?.['error'] ?? data),
      );
      res.status(502).json(data);
      return;
    }

    res.json(data);
  }),
);

const odptCenterKeySecret = defineSecret('ODPT_CENTER_KEY');
const odptChallengeKeySecret = defineSecret('ODPT_CHALLENGE_KEY');
const timetablePackBucket = defineString('TIMETABLE_PACK_BUCKET', {
  description: '時刻表パックを置く非公開の Cloud Storage バケット名',
});

export const refreshTimetablePacks = onSchedule(
  {
    schedule: '23 4 * * *',
    timeZone: 'Asia/Tokyo',
    secrets: [odptCenterKeySecret, odptChallengeKeySecret],
    memory: '2GiB',
    timeoutSeconds: 540,
    maxInstances: 1,
  },
  async () => {
    const bucket = getStorage().bucket(timetablePackBucket.value());
    const results = await refreshPacks({
      fetch: (url) => fetch(url),
      keys: {
        ODPT_CENTER_KEY: odptCenterKeySecret.value(),
        ODPT_CHALLENGE_KEY: odptChallengeKeySecret.value(),
      },
      now: () => new Date(),
      upload: (path, gzipped) =>
        bucket.file(path).save(Buffer.from(gzipped), {
          contentType: 'application/gzip',
          resumable: false,
        }),
      log: (event) => {
        if (event.status === 'failure' || event.status === 'skipped') {
          logger.write({ severity: 'WARNING', message: String(event.event), ...event });
        } else {
          logger.info(String(event.event), event);
        }
      },
    });
    const skipped = results.filter((r) => r.status === 'skipped').map((r) => r.group);
    if (skipped.length > 0) {
      throw new Error(`時刻表パックを更新できなかったグループ: ${skipped.join(', ')}`);
    }
  },
);

let scanDay = newScanDaySource();

function newScanDaySource() {
  return createScanDaySource({
    read: async (path) => {
      try {
        const [bytes] = await getStorage()
          .bucket(timetablePackBucket.value())
          .file(path)
          .download();
        return new Uint8Array(bytes);
      } catch (e) {
        if (isRecord(e) && e['code'] === 404) return null;
        throw e;
      }
    },
    log: (event) => {
      if (
        event.status === 'failure' ||
        event.status === 'missing' ||
        event.status === 'throttled'
      ) {
        logger.write({ severity: 'WARNING', message: String(event.event), ...event });
      } else {
        logger.info(String(event.event), event);
      }
    },
    now: () => Date.now(),
    heapUsed: () => process.memoryUsage().heapUsed,
  });
}

export function resetExactWalkMaxPacks(): void {
  scanDay = newScanDaySource();
}

const toWaypoint = ({ lat, lng }: LatLng) => ({ latitude: lat, longitude: lng });

const EXACT_MATRIX_FIELD_MASK = `${ROUTES_MATRIX_FIELD_MASK},status,condition`;

function isExactMatrixSuccessBody(data: unknown): data is unknown[] {
  return isRoutesMatrixSuccessBody(data) && !data.some(isFailedMatrixElement);
}

function isFailedMatrixElement(e: unknown): boolean {
  const code = asRecord(asRecord(e)?.['status'])?.['code'];
  return typeof code === 'number' && code !== 0;
}

async function measureWalks(origins: LatLng[], destinations: LatLng[]): Promise<MatrixElement[]> {
  const o = origins.map(toWaypoint);
  const d = destinations.map(toWaypoint);
  const { statusCode, data } = await callUpstream(
    'exactWalkMax',
    'routes-matrix',
    ROUTES_MATRIX_URL,
    'POST',
    {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getMapsApiKey(),
      'X-Goog-FieldMask': EXACT_MATRIX_FIELD_MASK,
    },
    buildRoutesMatrixBody(o, d),
    isExactMatrixSuccessBody,
    `exact-${matrixCacheKey(o, d)}`,
  );
  if (statusCode < 200 || statusCode >= 300 || !isExactMatrixSuccessBody(data)) {
    throw new UpstreamError(`matrix status ${statusCode}`, 'status');
  }
  return data.flatMap(toMatrixElement);
}

export function toMatrixElement(e: unknown): MatrixElement[] {
  const r = asRecord(e) ?? {};
  const m = typeof r['duration'] === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(r['duration']) : null;
  if (m === null) return [];
  return [
    {
      originIndex: integerOrZero(r['originIndex']),
      destinationIndex: integerOrZero(r['destinationIndex']),
      durationSec: Number(m[1]),
      distanceMeters: typeof r['distanceMeters'] === 'number' ? r['distanceMeters'] : 0,
    },
  ];
}

function integerOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : 0;
}

export const exactWalkMax = onRequest(
  { secrets: [mapsKeySecret, rateLimitHmacKeySecret], memory: '1GiB' },
  withRequestLatency('exactWalkMax', async (req, res) => {
    if (handleCors(req, res)) return;

    if (!(await verifyAppCheck(req, res, { endpoint: 'exactWalkMax' }))) return;

    if (!(await checkRateLimit(clientIp(req), RATE_LIMIT, 'exactWalkMax'))) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const parsed = parseExactWalkMaxQuery(req.query, new Date());
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const start = Date.now();
    let dayMs = 0;
    let matrixMs = 0;
    const stageMs: Record<ScanStage, number> = { pick: 0, rides: 0, journeys: 0 };
    try {
      const body = await findExactWalkMax(parsed, {
        timed: (stage, run) => {
          const t0 = performance.now();
          try {
            return run();
          } finally {
            stageMs[stage] = Math.round((performance.now() - t0) * 10) / 10;
          }
        },
        day: async (serviceDate) => {
          const t0 = Date.now();
          try {
            return await scanDay(serviceDate);
          } finally {
            dayMs = Date.now() - t0;
          }
        },
        measure: async (origins, destinations) => {
          const t0 = Date.now();
          try {
            return await measureWalks(origins, destinations);
          } finally {
            matrixMs = Math.max(matrixMs, Date.now() - t0);
          }
        },
      });
      if (body === null) {
        res.status(503).json({ error: 'timetable unavailable' });
        return;
      }
      const totalMs = Date.now() - start;
      logExactWalkMax({
        dayMs,
        matrixMs,
        scanMs: totalMs - dayMs - matrixMs,
        pickMs: stageMs.pick,
        ridesMs: stageMs.rides,
        journeysMs: stageMs.journeys,
        transfers: parsed.transfers,
        candidates: body.candidates.length,
        ...body.stats,
      });
      res.json(body);
    } catch (e) {
      const timedOut = e instanceof UpstreamError && e.kind === 'timeout';
      res
        .status(timedOut ? 504 : 502)
        .json({ error: timedOut ? 'upstream timeout' : 'upstream error' });
    }
  }),
);

export const rideDepartures = onRequest(
  { secrets: [rateLimitHmacKeySecret], memory: '1GiB' },
  withRequestLatency('rideDepartures', async (req, res) => {
    if (handleCors(req, res)) return;

    if (!(await verifyAppCheck(req, res, { endpoint: 'rideDepartures' }))) return;

    if (!(await checkRateLimit(clientIp(req), WALK_RATE_LIMIT, 'rideDepartures'))) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const parsed = parseRideDepartureQuery(req.query, new Date());
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const result = await resolveRideDeparture(parsed, {
      day: (serviceDate) => scanDay(serviceDate),
    });
    if (result === null) {
      res.status(503).json({ error: 'timetable unavailable' });
      return;
    }
    logRideDeparture({
      outcome: result.outcome,
      line: parsed.line,
      boardNamed: parsed.boardName.trim() !== '',
      alightNamed: parsed.alightName.trim() !== '',
    });
    res.json(result.response);
  }),
);
