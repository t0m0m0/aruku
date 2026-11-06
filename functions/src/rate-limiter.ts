import { createHmac } from "node:crypto";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

import { logRateLimit, type FailOpenReason } from "./metrics";

// 標準上限（IP あたり 30 req/min）。
export const RATE_LIMIT = 30;

// route_walk はハイブリッド経路探索で 1 検索あたり最大 13 回ファンアウトする
// サブリソースのため、標準の上限ではすぐ 429 になり機能が縮退する。
// 数回/分の検索を許容できるよう専用の高めの上限を設ける。
export const WALK_RATE_LIMIT = 90;

const WINDOW_MS = 60_000;

// scope 付きのエンドポイントは、同じ IP でも別のドキュメントで数える（#459）。
// 別のサービスのインスタンス同士が同じドキュメントを取り合うと、Firestore トランザクションが
// 競合し、再試行で約1秒ずつ待つ（本番ログ・エミュレータで確認済み）。同じインスタンスの中の
// 並列は admitInBatch がまとめるので競合しない。
// 区切りに "|" を使うのは、IPv4・IPv6 のどちらにも現れない文字のため。
function scopedKey(ip: string, scope: string | undefined): string {
  return scope === undefined ? ip : `${scope}|${ip}`;
}

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
  limit: number = RATE_LIMIT,
  scope?: string
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
    logRateLimit({ decision: "blocked" });
    return false;
  }
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
// rateLimits/{ip}（scope 付きは scope と IP の組）ドキュメントに {count, resetAt} を保持し、トランザクションで
// read→判定→increment する。複数インスタンスから同じドキュメントを更新するため
// IP 単位の上限がインスタンス横断で一貫して強制される。expireAt（Timestamp）は
// Firestore の TTL ポリシー用で、期限切れドキュメントを自動削除し無限増殖を防ぐ。
//
// コスト・レイテンシ上のトレードオフ（Issue #161）: トランザクションごとに 1 read + 1 write
// が発生する。同じインスタンスで重なった判定は1回にまとまるが、別のインスタンス同士は
// 競合し得る。将来的な移行先候補: (a) インスタンスローカルなメモリカウントを主とし
// 確率的に Firestore へ書き込む（横断精度を落として書き込み回数を削減）、(b) Cloud Armor /
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
/** プロビジョニング／Secret 登録をするまで解消しない不備を表す。 */
class RateLimitConfigError extends Error {}

function getRateLimitHmacKey(): string {
  const key = process.env.RATE_LIMIT_HMAC_KEY;
  if (key && key.length >= MIN_HMAC_KEY_LENGTH) return key;
  if (process.env.FUNCTIONS_EMULATOR === "true") return "aruku-emulator-fallback";
  throw new RateLimitConfigError(
    "RATE_LIMIT_HMAC_KEY unset or too short (>=32 chars required)"
  );
}

// gRPC ステータスコードのうち、リトライや時間経過では解消せず人手の設定変更を
// 要するもの。Firestore API 未有効化・DB 未作成は 7/5 で、まさに #301 の事象。
//
// なぜ FAILED_PRECONDITION(9) を含めないか:
//   9 は「Datastore モードのプロジェクト」のような恒久不備にも、複合インデックス
//   欠落のような可変要因にも使われ、意味が一意でない。誤って config に倒すと
//   「設定漏れ」アラートの信頼性が落ちる（config は必ず人を呼ぶ想定）。リミッタは
//   単一ドキュメントの get/set しか行わずインデックスに依存しないが、判別できない
//   コードを恒久側へ倒すより transient 側の既定に委ねる方が害が小さい。
const CONFIG_ERROR_GRPC_CODES = new Set([
  5, // NOT_FOUND: データベースが存在しない
  7, // PERMISSION_DENIED: API 未有効化 / IAM 不足
  16, // UNAUTHENTICATED: 資格情報の設定不備
]);

function classifyFailOpen(e: unknown): FailOpenReason {
  if (e instanceof RateLimitConfigError) return "config";
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "number" && CONFIG_ERROR_GRPC_CODES.has(code)) {
    return "config";
  }
  return "transient";
}

// 生 IP を Firestore に残さないための不可逆なドキュメント ID を導出する（#263）。
// encodeURIComponent は可逆で、ダンプ流出時に生 IP を復元できてしまう。SHA256 単体も
// IPv4 は全空間 43 億通りで総当たり逆引きされるため、鍵付き HMAC を採る。鍵は UTC 日付で
// 日次ローテーションし、鍵を持たない（ダンプのみの）攻撃者による日跨ぎの IP 相関を防ぐ。
// base secret 自体が漏洩した場合は日付が公開のため全日逆引きできるので、その限局には
// base secret の定期更新（運用手順）が必要。同一 IP は同日中は同一 ID へ、異なる IP は
// 異なる ID へ写像されるという写像の性質は維持される。
//
// なぜ日跨ぎのカウンタ引き継ぎをしないか（トレードオフ）:
//   ドキュメント ID が day を含むため、00:00 UTC（=09:00 JST）を跨ぐと同一 IP でも
//   新しい文書に切り替わり、旧文書の resetAt が未来でもカウントが 1 から再スタートする。
//   境界前後の最大 WINDOW_MS 区間で許容量が最大 2 倍に緩む。前日文書も併読すれば塞げるが、
//   毎回 2 read になりコスト増、かつ緩みは「1 日 1 回・固定時刻・上限は有界」でフェイル
//   オープン方針（Firestore 競合時は通過）と整合する軽微なもの。精度よりコストを採り、
//   この緩みは許容する。日跨ぎテストで挙動を固定している。
//   （なお TTL は容量掃除用で削除は expireAt 後 最大 24h。カウントの正しさは resetAt の
//   論理判定が担保し、TTL の遅延には依存しない。）
function docIdForIp(ip: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return createHmac("sha256", `${getRateLimitHmacKey()}:${day}`)
    .update(ip)
    .digest("hex");
}

type PendingCheck = {
  limit: number;
  resolve: (allowed: boolean) => void;
  reject: (error: unknown) => void;
};

// 文書 ID ごとの、次のトランザクションを待っている判定。キーがあるあいだは
// その文書のトランザクションが実行中で、無ければ誰も走っていない。
const _pendingChecks = new Map<string, PendingCheck[]>();

// なぜ文書をエンドポイント別に分けて競合を避けないか:
//   places・walk・matrix の共用カウンタが、1 IP の合計を WALK_RATE_LIMIT に抑えている。
//   分けると合計が 30+90+90 へ緩み、課金 API の守りが弱くなる（#482）。
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
      const decisions = await countBatch(docId, batch.map((c) => c.limit));
      batch.forEach((check, i) => check.resolve(decisions[i]));
    } catch (e) {
      batch.forEach((check) => check.reject(e));
    }
  }
}

async function countBatch(docId: string, limits: number[]): Promise<boolean[]> {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(docId);
  const now = Date.now();
  // Firestore はドキュメント競合時にこのコールバックを再試行するため、数え直せるよう
  // カウントは必ず内側で読んだ値から積む。
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as { count: number; resetAt: number } | undefined;
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
  scope?: string
): Promise<boolean> {
  try {
    const docId = docIdForIp(scopedKey(ip, scope), Date.now());
    const allowed = await admitInBatch(docId, limit);
    if (!allowed) {
      logRateLimit({ decision: "blocked" });
    }
    return allowed;
  } catch (e) {
    // フェイルオープン: レート制限の障害で課金 API 全体を落とさない。
    // 一次の濫用防止は App Check が担う。検知のためログは残す。
    //
    // なぜ理由を分類してから記録するか:
    //   競合由来のフェイルオープンは README「制約・トレードオフ」で許容済みのため
    //   アラートは実運用でミュートされる。設定不備由来を同じ信号に混ぜると、
    //   保護が恒久的に無効な状態がそのノイズに埋もれる（#301 の実害）。
    const reason = classifyFailOpen(e);
    console.error(
      `[rateLimiter] Firestore error, failing open (reason=${reason}):`,
      e
    );
    logRateLimit({ decision: "fail-open", reason });
    return true;
  }
}

// ---------------------------------------------------------------------------
// ディスパッチャ
// ---------------------------------------------------------------------------
export function checkRateLimit(
  ip: string,
  limit: number = RATE_LIMIT,
  scope?: string
): Promise<boolean> {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return Promise.resolve(checkRateLimitInMemory(ip, limit, scope));
  }
  return checkRateLimitFirestore(ip, limit, scope);
}
