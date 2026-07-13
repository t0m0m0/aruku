// 上流 API 呼び出しの重複排除層（issue #274）。
//
// 目的: キャンセル→即再検索や同一経路の短時間引き直しで、課金対象の Google Routes
// プロキシへ同一クエリが連続する。これを (a) in-flight の共有（single-flight）と
// (b) 解決後の短期 TTL 保持で 1 回の上流呼び出しへ集約し、Routes API のコール・課金を
// 削減する。
//
// なぜインメモリか（Firestore にしない理由）:
//   Cloud Functions は複数インスタンスで動くため、この集約はインスタンスローカルに
//   しか効かない（レートリミッタのインメモリ実装と同じ制約）。横断集約には Firestore
//   等の共有ストアが要るが、1 read/write のラウンドトリップと課金が乗り、まさに削りたい
//   コスト・レイテンシを増やして本末転倒になる。キャンセル→即再検索のバーストは同一
//   クライアントから短時間に飛び、温まった同一インスタンスへ着地しやすいため、
//   インスタンスローカルでも実効的な削減が見込める。精度でなく実利で採る。
//
// なぜ失敗を保持しないか:
//   TTL 保持は成功結果のみ。上流の失敗（タイムアウト・4xx/5xx・意味的失敗）を数十秒
//   固定すると、一時障害からの回復をキャッシュが遅らせる。in-flight の共有は成否を
//   問わず行う（同時発生した重複は 1 回の失敗で束ね、各 caller が自分の応答を書く）が、
//   解決後の保持は isCacheable が真のときだけに限定する。

// 徒歩ルートは街路ジオメトリで実質不変のため、TTL は鮮度でなくメモリの有界化と
// キャンセル→即再検索バーストの吸収窓として決める。数十秒レンジの保守的な初期値。
export const UPSTREAM_CACHE_TTL_MS = 30_000;

// 保持キャッシュの上限。短時間窓で異なる経路キーは高々数十のため十分な余裕を持たせた値。
export const MAX_CACHE_ENTRIES = 500;

interface ResolvedEntry<T> {
  value: T;
  expiresAt: number;
}

// in-flight（解決前）の promise。成否問わず同一キーの並行 caller が相乗りする。
const _inflight = new Map<string, Promise<unknown>>();
// 解決済みの成功結果（TTL 付き）。
const _resolved = new Map<string, ResolvedEntry<unknown>>();

/** テスト用: 重複排除の状態（in-flight・保持キャッシュ）を初期化する。 */
export function resetUpstreamCache(): void {
  _inflight.clear();
  _resolved.clear();
}

/** テスト用: 保持キャッシュの現在のエントリ数を返す。 */
export function upstreamCacheSize(): number {
  return _resolved.size;
}

function pruneExpired(now: number): void {
  for (const [k, entry] of _resolved) {
    if (now >= entry.expiresAt) _resolved.delete(k);
  }
}

// 保持前に上限を強制する。まず期限切れを掃除し、なお満杯なら最古を退避する。
// TTL 内で高カーディナリティ（多数の異なる経路/秒）が続くと期限切れが無く掃除が
// 効かないため、掃除だけでは QPS×TTL まで膨らむ。ハード上限を保つには退避が要る。
// Map は挿入順を保つため最古の挿入キー＝一様 TTL では最も早く期限切れになるキーで、
// FIFO 退避は「もうすぐ消える分を先に落とす」ことに一致する。
function evictForInsert(now: number): void {
  if (_resolved.size < MAX_CACHE_ENTRIES) return;
  pruneExpired(now);
  while (_resolved.size >= MAX_CACHE_ENTRIES) {
    const oldest = _resolved.keys().next().value;
    if (oldest === undefined) break;
    _resolved.delete(oldest);
  }
}

/**
 * key で上流呼び出しを重複排除する。
 * - 解決済みキャッシュが TTL 内なら producer を呼ばずその値を返す。
 * - 同一キーが in-flight ならその promise を共有する（single-flight）。
 * - それ以外は producer を呼び、成功かつ isCacheable が真なら TTL 保持する。
 * producer の reject はキャッシュせず、共有中の全 caller へそのまま伝播する。
 */
export function dedupeUpstream<T>(
  key: string,
  producer: () => Promise<T>,
  isCacheable: (value: T) => boolean,
  ttlMs: number = UPSTREAM_CACHE_TTL_MS
): Promise<T> {
  const now = Date.now();

  const cached = _resolved.get(key);
  if (cached) {
    if (now < cached.expiresAt) return Promise.resolve(cached.value as T);
    _resolved.delete(key);
  }

  const pending = _inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = producer()
    .then((value) => {
      if (isCacheable(value)) {
        evictForInsert(Date.now());
        _resolved.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    })
    .finally(() => {
      _inflight.delete(key);
    });

  _inflight.set(key, promise);
  return promise;
}
