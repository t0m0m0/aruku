// 移植元: lib/l10n/app_ja.arb（gen-l10n）。
//
// gen-l10n 相当の仕組みは持ち込まない。ロケールは ja だけで、移植元の 299 キーも
// すべて ja のみ定義されている。react-i18next 等を入れると、実在しない多言語要件の
// ためにバンドルと間接参照が増え、キーの参照漏れも実行時まで落ちない。型付きの
// 定数なら tsc が落とす。多言語化が要るようになった時点で、この 1 モジュールを
// 差し替えればよい。

export const ja = {
  /// アイコンボタンの待ち表示の既定文言。呼び出し側が具体的に言えるなら上書きする。
  busyDefault: '処理中',

  weekdays: ['月', '火', '水', '木', '金', '土', '日'],
  greetingMorning: 'おはようございます',
  greetingAfternoon: 'こんにちは',
  greetingEvening: 'こんばんは',

  homeGreetingLead: '今日も、',
  homeGreetingHighlight: '歩こう。',
  homeOpenSettings: '設定を開く',
  homeDepartureLabel: '出発',
  homeArrivalLabel: '到着',
  homeDestinationLabel: '目的地',
  homeDestinationPlaceholder: 'どこへ歩く?',
  homeRefreshLocation: '現在地を再取得',
  homeRefreshingLocation: '現在地を取得中',
  homeSearchDestination: '目的地を検索',
  homeTimeSectionLabel: '時間',
  homeWalkableSuffix: ' 歩ける',
  homeSearchRoute: 'ルートを検索',

  /// 経路検索のライフサイクルが未移植の間の CTA。押せない状態と対で出す。
  homeSearchRouteNotReady: '経路検索は準備中',
  homeChooseDestination: '目的地を選ぶ',

  commonBack: '戻る',

  searchOriginHint: '出発地を検索',
  searchDestinationHint: '目的地を検索',
  searchClearInput: '入力を消去',
  searchNearbyToggle: '近くの店',
  searchUseCurrentLocation: '現在地を使う',
  searchCurrentLocationName: '現在地',
  searchRecentOrigins: '最近の出発地',
  searchRecentDestinations: '最近の目的地',
  searchClearHistory: '履歴を消去',
  searchEmptyTitle: '候補が見つかりませんでした',
  searchEmptyHint: '別のキーワードで試してください',
  searchErrorGeneric: '検索できませんでした',
  searchNetworkHint: '通信状況を確認してください',
  searchPickFailedOrigin:
    'この出発地は位置情報を取得できませんでした。別の候補を選んでください',
  searchPickFailedDestination:
    'この目的地は位置情報を取得できませんでした。別の候補を選んでください',
  searchResolvingPlace: '地点を確定中',

  loadingSearchingMessage: '歩ける道を、探しています',
  loadingCancelButton: 'キャンセル',

  routeErrorNetworkTitle: '通信に失敗しました',
  routeErrorNetworkDescription: '通信状況を確認してもう一度お試しください',
  routeErrorTimeoutTitle: '経路サービスの応答が遅れています',
  routeErrorTimeoutDescription:
    '混み合っているようです。少し時間をおいてもう一度お試しください',
  routeErrorNoResultsTitle: 'ルートが見つかりませんでした',
  routeErrorNoResultsDescription: '目的地や出発・到着時刻を変えてお試しください',
  routeErrorNoLocationTitle: '現在地を取得できませんでした',
  routeErrorNoLocationDescription: '位置情報を有効にしてもう一度お試しください',
  routeErrorNoDestinationTitle: '目的地が選ばれていません',
  routeErrorNoDestinationDescription: '目的地を選んでもう一度検索してください',
  routeErrorUnknownTitle: 'ルートを取得できませんでした',
  routeErrorUnknownDescription: '時間をおいてもう一度お試しください',
  errorRetry: '再試行',

  resultChangeConditions: '条件を変更',
  resultBackToSearch: '検索に戻る',

  /// 出発地の表示名。移植元は app_state.dart に直書きしていた（ARB に無い）。
  /// 文言なので他と同じくここへ置く。
  departureCurrentLocationLoading: '現在地 · 取得中...',
  departureCurrentLocation: '現在地',
  departureNoLocation: '位置情報なし',
  departureCurrentLocationFailed: '現在地 · 取得失敗',
} as const;

/// 移植元の searchErrorWithStatus（プレースホルダ付き ARB）。gen-l10n を持ち込まない
/// ので、置換は関数で表す——型が引数の有無を落とす。
export function searchErrorWithStatus(status: string): string {
  return `検索できませんでした (${status})`;
}
