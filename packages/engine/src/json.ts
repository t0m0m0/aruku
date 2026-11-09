/// Dart の `Map<String, dynamic>` / `List<dynamic>`（Transit API・プロキシの生 JSON）に
/// 対応する。パーサは受け取った値の型を実行時に確かめてから読む——上流は無認証・無 SLA の
/// 第三者 API で、スキーマは契約ではないため。
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonMap = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/// Dart の `(x as num?)?.toInt() ?? fallback`。
export function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? Math.trunc(value) : fallback;
}
