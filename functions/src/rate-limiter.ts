import { createHmac } from 'node:crypto';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { isRecord } from './json';
import { logRateLimit, type FailOpenReason } from './metrics';

export const RATE_LIMIT = 30;

export const WALK_RATE_LIMIT = 90;

const WINDOW_MS = 60_000;

function scopedKey(ip: string, scope: string | undefined): string {
  return scope === undefined ? ip : `${scope}|${ip}`;
}

const _rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimitInMemory(
  ip: string,
  limit: number = RATE_LIMIT,
  scope?: string,
): boolean {
  const key = scopedKey(ip, scope);
  const now = Date.now();
  if (_rateLimitMap.size > 1000) {
    for (const [k, v] of _rateLimitMap) {
      if (now > v.resetAt) _rateLimitMap.delete(k);
    }
  }
  const entry = _rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    _rateLimitMap.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) {
    logRateLimit({ decision: 'blocked' });
    return false;
  }
  entry.count++;
  return true;
}

export function resetRateLimit(): void {
  _rateLimitMap.clear();
}

export function rateLimitMapSize(): number {
  return _rateLimitMap.size;
}

const COLLECTION = 'rateLimits';

const MIN_HMAC_KEY_LENGTH = 32;

class RateLimitConfigError extends Error {}

function getRateLimitHmacKey(): string {
  const key = process.env.RATE_LIMIT_HMAC_KEY;
  if (key !== undefined && key.length >= MIN_HMAC_KEY_LENGTH) return key;
  if (process.env.FUNCTIONS_EMULATOR === 'true') return 'aruku-emulator-fallback';
  throw new RateLimitConfigError('RATE_LIMIT_HMAC_KEY unset or too short (>=32 chars required)');
}

const CONFIG_ERROR_GRPC_CODES = new Set([5, 7, 16]);

function classifyFailOpen(e: unknown): FailOpenReason {
  if (e instanceof RateLimitConfigError) return 'config';
  const code = isRecord(e) ? e['code'] : undefined;
  if (typeof code === 'number' && CONFIG_ERROR_GRPC_CODES.has(code)) {
    return 'config';
  }
  return 'transient';
}

function docIdForIp(ip: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return createHmac('sha256', `${getRateLimitHmacKey()}:${day}`).update(ip).digest('hex');
}

type PendingCheck = {
  limit: number;
  resolve: (allowed: boolean) => void;
  reject: (error: unknown) => void;
};

const _pendingChecks = new Map<string, PendingCheck[]>();

function admitInBatch(docId: string, limit: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const check = { limit, resolve, reject };
    const pending = _pendingChecks.get(docId);
    if (pending) {
      pending.push(check);
      return;
    }
    _pendingChecks.set(docId, [check]);
    void drainPendingChecks(docId);
  });
}

async function drainPendingChecks(docId: string): Promise<void> {
  for (;;) {
    const batch = _pendingChecks.get(docId) ?? [];
    if (batch.length === 0) {
      _pendingChecks.delete(docId);
      return;
    }
    _pendingChecks.set(docId, []);
    try {
      const decisions = await countBatch(
        docId,
        batch.map((c) => c.limit),
      );
      batch.forEach((check, i) => check.resolve(decisions[i]));
    } catch (e) {
      batch.forEach((check) => check.reject(e));
    }
  }
}

function readWindow(data: unknown): { count: number; resetAt: number } | undefined {
  if (!isRecord(data)) return undefined;
  const { count, resetAt } = data;
  return typeof count === 'number' && typeof resetAt === 'number' ? { count, resetAt } : undefined;
}

async function countBatch(docId: string, limits: number[]): Promise<boolean[]> {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(docId);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = readWindow(snap.data());
    const windowExpired = !data || now > data.resetAt;
    const before = windowExpired ? 0 : data.count;
    let count = before;
    const decisions = limits.map((limit) => {
      if (count >= limit) return false;
      count++;
      return true;
    });
    if (windowExpired) {
      const resetAt = now + WINDOW_MS;
      tx.set(ref, { count, resetAt, expireAt: Timestamp.fromMillis(resetAt) });
    } else if (count > before) {
      tx.update(ref, { count });
    }
    return decisions;
  });
}

export async function checkRateLimitFirestore(
  ip: string,
  limit: number = RATE_LIMIT,
  scope?: string,
): Promise<boolean> {
  try {
    const docId = docIdForIp(scopedKey(ip, scope), Date.now());
    const allowed = await admitInBatch(docId, limit);
    if (!allowed) {
      logRateLimit({ decision: 'blocked' });
    }
    return allowed;
  } catch (e) {
    const reason = classifyFailOpen(e);
    console.error(`[rateLimiter] Firestore error, failing open (reason=${reason}):`, e);
    logRateLimit({ decision: 'fail-open', reason });
    return true;
  }
}

export function checkRateLimit(
  ip: string,
  limit: number = RATE_LIMIT,
  scope?: string,
): Promise<boolean> {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    return Promise.resolve(checkRateLimitInMemory(ip, limit, scope));
  }
  return checkRateLimitFirestore(ip, limit, scope);
}
