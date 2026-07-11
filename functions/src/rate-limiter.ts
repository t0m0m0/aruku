import { createHmac } from "node:crypto";
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
//
// コスト・レイテンシ上のトレードオフ（Issue #161）: 呼び出しごとに 1 read + 1 write の
// トランザクションが発生し、1 検索が最大 13 回ファンアウトする経路では積み上がる。
// 将来的な移行先候補: (a) インスタンスローカルなメモリカウントを主とし確率的に
// Firestore へ書き込む（横断精度を落として書き込み回数を削減）、(b) Cloud Armor /
// API Gateway 側でのレート制限への移行。現状は精度優先でこの実装を維持している。
// ---------------------------------------------------------------------------
const COLLECTION = "rateLimits";

// ドキュメント ID を導出する HMAC 鍵の最小長（文字数）。弱鍵は鍵自体の総当たりを
// 許し、逆引きを再び現実的にするため下限を設ける。README は openssl rand -hex 32
// （64 文字）を推奨する。
const MIN_HMAC_KEY_LENGTH = 32;

// レート制限のドキュメント ID を導出する鍵。バインドされた Secret が
// process.env 経由で渡る（本番は firebase functions:secrets:set で登録）。
//
// なぜ本番で固定フォールバック鍵に丸めないか：
//   公開された既知鍵でも「同一 IP → 同一 ID」の写像は保たれるためレート制限は動き、
//   観測上は何も壊れない。しかし攻撃者は既知鍵で IPv4 全空間を総当たりして全 ID を
//   生 IP へ逆引きでき、#263 の不可逆化だけが静かに無効化される。「動くのに保護が
//   無い」を避けるため、本番相当で鍵が無い/弱いときは例外にする。例外は呼び出し側の
//   try で捕捉されフェイルオープン（通過）するため、可用性は保ちつつ「逆引き可能な
//   ドキュメントは一切書かない」。フォールバックはエミュレータ専用に限定する。
function getRateLimitHmacKey(): string {
  const key = process.env.RATE_LIMIT_HMAC_KEY;
  if (key && key.length >= MIN_HMAC_KEY_LENGTH) return key;
  if (process.env.FUNCTIONS_EMULATOR === "true") return "aruku-emulator-fallback";
  throw new Error(
    "RATE_LIMIT_HMAC_KEY unset or too short (>=32 chars required)"
  );
}

// 生 IP を Firestore に残さないための不可逆なドキュメント ID を導出する（#263）。
// encodeURIComponent は可逆で、ダンプ流出時に生 IP を復元できてしまう。SHA256 単体も
// IPv4 は全空間 43 億通りで総当たり逆引きされるため、鍵付き HMAC を採る。鍵は UTC 日付で
// 日次ローテーションし、鍵を持たない（ダンプのみの）攻撃者による日跨ぎの IP 相関を防ぐ
// （カウンタ文書は TTL で 60 秒以内に消えるため回転による機能影響は無い）。base secret
// 自体が漏洩した場合は日付が公開のため全日逆引きできるので、その限局には base secret の
// 定期更新（運用手順）が必要。同一 IP は同日中は同一 ID へ、異なる IP は異なる ID へ
// 写像されるという写像の性質は維持される。
function docIdForIp(ip: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return createHmac("sha256", `${getRateLimitHmacKey()}:${day}`)
    .update(ip)
    .digest("hex");
}

export async function checkRateLimitFirestore(
  ip: string,
  limit: number = RATE_LIMIT
): Promise<boolean> {
  try {
    const db = getFirestore();
    // ドキュメント ID は日次ローテーション鍵に依存するため now を先に確定し、
    // トランザクション内のウィンドウ判定にも同一の now を用いる（真夜中 UTC を
    // 跨ぐ稀な再試行でも ID と判定の日付がずれない）。
    const now = Date.now();
    const ref = db.collection(COLLECTION).doc(docIdForIp(ip, now));
    return await db.runTransaction(async (tx) => {
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
