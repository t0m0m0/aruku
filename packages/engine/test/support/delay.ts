/// Dart の `Future<void>.delayed(Duration(milliseconds: n))` に対応する。 doc-consistency:keep（Dart の名前付き引数で、TS 側の関数ではない）
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
