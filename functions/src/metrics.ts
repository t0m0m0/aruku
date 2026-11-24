import type { RideDepartureOutcome } from './ride-departures';
import { logger } from 'firebase-functions';

export type RequestStatus = 'success' | 'failure';

export interface RequestOutcomeParams {
  endpoint: string;
  upstream: string;
  status: RequestStatus;
  latencyMs: number;
  httpStatus?: number;
  semanticFailure?: boolean;
}

export function logRequestOutcome(params: RequestOutcomeParams): void {
  const { endpoint, upstream, status, latencyMs, httpStatus, semanticFailure } = params;
  const payload = {
    event: 'search_request',
    endpoint,
    upstream,
    status,
    latencyMs,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(httpStatus === 429 ? { rateLimited: true } : {}),
    ...(semanticFailure === true ? { semanticFailure: true } : {}),
  };
  if (status === 'success') {
    logger.info('search_request', payload);
  } else {
    logger.write({ severity: 'ERROR', message: 'search_request', ...payload });
  }
}

export interface RequestLatencyParams {
  endpoint: string;
  totalLatencyMs: number;
  httpStatus: number;
  appCheckMs?: number;
}

export function logRequestLatency(params: RequestLatencyParams): void {
  logger.info('request_latency', {
    event: 'request_latency',
    endpoint: params.endpoint,
    totalLatencyMs: params.totalLatencyMs,
    httpStatus: params.httpStatus,
    ...(params.appCheckMs === undefined ? {} : { appCheckMs: params.appCheckMs }),
  });
}

export type AppCheckDenialReason = 'missing' | 'invalid' | 'replayed';

export interface AppCheckDeniedParams {
  endpoint: string;
  reason: AppCheckDenialReason;
}

export function logAppCheckDenied(params: AppCheckDeniedParams): void {
  logger.warn('app_check_denied', {
    event: 'app_check_denied',
    endpoint: params.endpoint,
    reason: params.reason,
  });
}

export type RateLimitDecision = 'allowed' | 'blocked' | 'fail-open';

export type FailOpenReason = 'config' | 'transient';

export type RateLimitParams =
  | { decision: Exclude<RateLimitDecision, 'fail-open'> }
  | { decision: 'fail-open'; reason: FailOpenReason };

export function logRateLimit(params: RateLimitParams): void {
  const payload = {
    event: 'rate_limit',
    decision: params.decision,
    ...(params.decision === 'fail-open' ? { reason: params.reason } : {}),
  };
  if (params.decision === 'fail-open') {
    logger.write({ severity: 'ERROR', message: 'rate_limit', ...payload });
  } else if (params.decision === 'blocked') {
    logger.warn('rate_limit', payload);
  } else {
    logger.info('rate_limit', payload);
  }
}

export interface ExactWalkMaxParams {
  dayMs: number;
  matrixMs: number;
  scanMs: number;
  pickMs: number;
  ridesMs: number;
  journeysMs: number;
  transfers: boolean;
  candidates: number;
  tripsScanned: number;
  elementsMeasured: number;
  truncated: boolean;
}

export function logExactWalkMax(params: ExactWalkMaxParams): void {
  logger.info('exact_walk_max', { event: 'exact_walk_max', ...params });
}

export interface RideDepartureLogParams {
  outcome: RideDepartureOutcome;
  line: string;
  boardNamed: boolean;
  alightNamed: boolean;
}

export function logRideDeparture(params: RideDepartureLogParams): void {
  logger.info('ride_departure', { event: 'ride_departure', ...params });
}
