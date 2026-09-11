/// Dart の `debugPrint`（`package:flutter/foundation.dart`）に対応する。
///
/// 引数で注入する形（`new RouteDiagnostics({ print })`）にしていないのは、移植元が
/// **ライブラリレベルの可変関数変数を差し替える**形でテストしているため（`debugPrint =
/// (message, {wrapWidth}) => lines.add(message)`）。依存の渡し方を変えると、その差し替えを
/// 使うテストが「移植」ではなく「書き直し」になる。ESM の live binding で同じ形が作れる。
export let debugPrint: (message: string | null) => void = (message) => {
  console.log(message);
};

export function setDebugPrint(fn: (message: string | null) => void): void {
  debugPrint = fn;
}
