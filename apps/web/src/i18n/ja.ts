// 移植元: lib/l10n/app_ja.arb（gen-l10n）。
//
// gen-l10n 相当の仕組みは持ち込まない。ロケールは ja だけで、移植元の 299 キーも
// すべて ja のみ定義されている。react-i18next 等を入れると、実在しない多言語要件の
// ためにバンドルと間接参照が増え、キーの参照漏れも実行時まで落ちない。型付きの
// 定数なら tsc が落とす。多言語化が要るようになった時点で、この 1 モジュールを
// 差し替えればよい。

export const ja = {
  /// 出発地の表示名。移植元は app_state.dart に直書きしていた（ARB に無い）。
  /// 文言なので他と同じくここへ置く。
  departureCurrentLocationLoading: '現在地 · 取得中...',
  departureCurrentLocation: '現在地',
  departureNoLocation: '位置情報なし',
  departureCurrentLocationFailed: '現在地 · 取得失敗',
} as const;
