import { getFirestore, Timestamp } from "firebase-admin/firestore";

// 標準上限（IP あたり 30 req/min）。
export const RATE_LIMIT = 30;

// route_walk はハイブリッド経路探索で 1 検索あたり最大 13 回ファンアウトする
// サブリソースのため、標準の上限ではすぐ 429 になり機能が縮退する。
// 数回/分の検索を許容できるよう専用の高めの上限を設ける。
export const WALK_RATE_LIMIT = 90;

const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// インメモリ実装（エミュレータ専用）
//
// Cloud Functions は複数インスタンスで動くため、Map ベースの上限はインスタンス
// ローカルでしか効かない（横断強制は Firestore 実装が担う）。エミュレータでは
// Firestore エミュレータを起動せずローカル開発できるよう、こちらにフォールバック
// する。API キー / App Check と同じく FUNCTIONS_EMULATOR で分岐する。
// ---------------------------------------------------------------------------
const _rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimitInMemory(
  ip: string,
  limit: number = RATE_LIMIT
): boolean {
  const now = Date.now();
  if (_rateLimitMap.size > 1000) {
    for (const [k, v] of _rateLimitMap) {
      if (now > v.resetAt) _rateLimitMap.delete(k);
    }
  }
  const entry = _rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateLimitMap.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

/** テスト用: インメモリのレート制限状態を初期化する。 */
export function resetRateLimit(): void {
  _rateLimitMap.clear();
}

/** テスト用: インメモリのレート制限マップの現在のエントリ数を返す。 */
export function rateLimitMapSize(): number {
  return _rateLimitMap.size;
}

// ---------------------------------------------------------------------------
// Firestore 実装（本番）
//
// rateLimits/{ip} ドキュメントに {count, resetAt} を保持し、トランザクションで
// read→判定→increment する。複数インスタンスから同じドキュメントを更新するため
// IP 単位の上限がインスタンス横断で一貫して強制される。expireAt（Timestamp）は
// Firestore の TTL ポリシー用で、期限切れドキュメントを自動削除し無限増殖を防ぐ。
// ---------------------------------------------------------------------------
const COLLECTION = "rateLimits";

// IPv6 のコロン等を含む IP を安全なドキュメント ID に変換する。
// Firestore のドキュメント ID は "/" を含められないが encodeURIComponent で除去され、
// 同一 IP は常に同一 ID へ写像される。
function docIdForIp(ip: string): string {
  return encodeURIComponent(ip);
}

export async function checkRateLimitFirestore(
  ip: string,
  limit: number = RATE_LIMIT
): Promise<boolean> {
  try {
    const db = getFirestore();
    const ref = db.collection(COLLECTION).doc(docIdForIp(ip));
    return await db.runTransaction(async (tx) => {
      const now = Date.now();
      const snap = await tx.get(ref);
      const data = snap.data() as
        | { count: number; resetAt: number }
        | undefined;
      if (!data || now > data.resetAt) {
        const resetAt = now + WINDOW_MS;
        tx.set(ref, {
          count: 1,
          resetAt,
          expireAt: Timestamp.fromMillis(resetAt),
        });
        return true;
      }
      if (data.count >= limit) return false;
      tx.update(ref, { count: data.count + 1 });
      return true;
    });
  } catch (e) {
    // フェイルオープン: レート制限の障害で課金 API 全体を落とさない。
    // 一次の濫用防止は App Check が担う。検知のためログは残す。
    console.error("[rateLimiter] Firestore error, failing open:", e);
    return true;
  }
}

// ---------------------------------------------------------------------------
// ディスパッチャ
// ---------------------------------------------------------------------------
export function checkRateLimit(
  ip: string,
  limit: number = RATE_LIMIT
): Promise<boolean> {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return Promise.resolve(checkRateLimitInMemory(ip, limit));
  }
  return checkRateLimitFirestore(ip, limit);
}
