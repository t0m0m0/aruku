export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonMap = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? Math.trunc(value) : fallback;
}
