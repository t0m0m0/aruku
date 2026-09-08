/// Dart の `Future<void>.delayed(Duration(milliseconds: n))` に対応する。
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
