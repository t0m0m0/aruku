export const ja = {
  appTitle: 'あるく',

  shellHome: 'あるく ホームへ戻る',

  weekdays: ['月', '火', '水', '木', '金', '土', '日'],

  homeTagline: '間に合う範囲でいちばん歩くルート',
  homeTaglineDescription: '最短ルートではなく、時間いっぱい歩けるようなルートを提示します',

  homeDepartureLabel: '出発',
  homeArrivalLabel: '到着',
  homeDestinationLabel: '目的地',
  homeDestinationPlaceholder: 'どこへ歩く?',
  homeTimeSectionLabel: '時間',
  homeWalkablePrefix: '最大 ',
  homeWalkableSuffix: ' 歩ける',
  homeSearchRoute: '歩けるルートを探す',

  legalSection: '法的情報',
  legalTermsOfService: '利用規約',
  legalPrivacyPolicy: 'プライバシーポリシー',

  timeFieldTime: (label: string) => `${label}の時刻`,
  timeFieldDate: (label: string) => `${label}の日付`,

  timeFieldLater: (label: string) => `${label}を5分あとにする`,
  timeFieldEarlier: (label: string) => `${label}を5分まえにする`,
  timeFieldNextDay: (label: string) => `${label}を1日あとにする`,
  timeFieldPrevDay: (label: string) => `${label}を1日まえにする`,

  timeFieldDateButton: (label: string, date: string) => `${label}の日付 ${date}`,
  dateToday: '今日',
  dateTomorrow: '明日',

  calendarCaption: (year: number, month: number) => `${year}年${month}月`,
  calendarWeekdayLabel: (weekday: string) => `${weekday}曜日`,
  calendarDayLabel: (date: string, state: { today: boolean; selected: boolean }) =>
    [state.today ? '今日' : null, date, state.selected ? '選択中' : null]
      .filter((part) => part !== null)
      .join('、'),
  calendarPreviousMonth: '前の月',
  calendarNextMonth: '次の月',

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
  searchPickFailedOrigin: 'この出発地は位置情報を取得できませんでした。別の候補を選んでください',
  searchPickFailedDestination:
    'この目的地は位置情報を取得できませんでした。別の候補を選んでください',
  searchResolvingPlace: '地点を確定中',

  loadingSearchingMessage: '歩ける道を、探しています',
  loadingCancelButton: 'キャンセル',

  routeErrorNetworkTitle: '通信に失敗しました',
  routeErrorNetworkDescription: '通信状況を確認してもう一度お試しください',
  routeErrorTimeoutTitle: '経路サービスの応答が遅れています',
  routeErrorTimeoutDescription: '混み合っているようです。少し時間をおいてもう一度お試しください',
  routeErrorNoResultsTitle: 'ルートが見つかりませんでした',
  routeErrorNoResultsDescription: '目的地や出発・到着時刻を変えてお試しください',
  routeErrorNoLocationTitle: '現在地を取得できませんでした',
  routeErrorNoLocationDescription:
    'ブラウザのサイト設定で位置情報を許可して、もう一度お試しください',
  routeErrorNoDestinationTitle: '目的地が選ばれていません',
  routeErrorNoDestinationDescription: '目的地を選んでもう一度検索してください',
  routeErrorUnknownTitle: 'ルートを取得できませんでした',
  routeErrorUnknownDescription: '時間をおいてもう一度お試しください',
  errorRetry: '再試行',

  resultChangeConditions: '条件を変更',
  resultBackToSearch: '検索に戻る',
  resultNoRouteMessage: 'ルートがありません',
  resultOverBudgetHint: '時間内に到達できる経路がないため、最短の経路を表示しています',
  resultStandardLead: 'ふつうの乗換ルートより',
  resultSegmentsHeading: '区間',
  resultAuxiliaryHeading: 'このルートについて',
  resultWalkLabel: '徒歩',
  resultTrainDefaultLabel: '電車',
  resultBusDefaultLabel: 'バス',
  resultLegOpenInMaps: 'Googleマップで開く',

  timetableAttributionHeading: '時刻表データについて',
  timetableAttributionSource:
    '時刻表は、公共交通オープンデータセンターが提供するデータを利用しています。',
  timetableAttributionDisclaimer: 'データの正確性・完全性は保証されません。',
  timetableAttributionContactLead:
    '時刻表やルートについて、交通事業者へは問い合わせないでください。',
  timetableAttributionContact: 'あるくへのお問い合わせ',
  timetableAttributionFetchedAt: '取得日時',
  timetableAttributionToeiCredit:
    '東京都交通局の時刻表は、東京都交通局・公共交通オープンデータ協議会が提供するデータを加工して利用しています。ライセンス：',
  timetableAttributionMiniTokyo3dLead:
    '東急・小田急・京急・西武・京成など、公共交通オープンデータセンターから取れない事業者の時刻表は、',
  timetableAttributionMiniTokyo3dCredit:
    '（Copyright (c) 2019-2025 Akihiko Kusanagi・MIT License）のデータを加工して利用しています。',
  timetableFeedNames: {
    'JR-East': 'JR東日本',
    Keio: '京王電鉄',
    Tobu: '東武鉄道',
    Sotetsu: '相模鉄道',
    TokyoMetro: '東京メトロ',
    MIR: 'つくばエクスプレス',
    TWR: 'りんかい線',
    TamaMonorail: '多摩モノレール',
    YokohamaMunicipal: '横浜市交通局',
    Toei: '東京都交通局',
  } as Readonly<Record<string, string>>,

  departureCurrentLocationLoading: '現在地 · 取得中...',
  departureCurrentLocation: '現在地',
  departureNoLocation: '位置情報なし',
  departureCurrentLocationFailed: '現在地 · 取得失敗',
} as const;

export function searchErrorWithStatus(status: string): string {
  return `検索できませんでした (${status})`;
}

export function resultDepartureLabel(dateLabel: string, time: string): string {
  return `${dateLabel} · ${time} 出発`;
}

export function resultSlack(deadline: string, slack: string): string {
  return `${deadline} まで ${slack} 余裕`;
}

export function resultCalories(kcal: number): string {
  return `消費カロリー ${kcal} kcal`;
}

export function resultOverBudgetTitle(overMinutes: number): string {
  return `制限時間を${overMinutes}分超過しています`;
}

export interface DurationPart {
  readonly text: string;
  readonly unit: boolean;
}

export function resultSegmentDuration(minutes: number): DurationPart[] {
  if (minutes >= 60) {
    return [
      { text: String(Math.floor(minutes / 60)), unit: false },
      { text: '時間', unit: true },
      { text: String(minutes % 60).padStart(2, '0'), unit: false },
      { text: '分', unit: true },
    ];
  }
  return [
    { text: String(minutes), unit: false },
    { text: '分', unit: true },
  ];
}

export function resultLegOpenInMapsLabel(legLabel: string, toName: string): string {
  const leg = toName === '' ? legLabel : `${toName}までの${legLabel}`;
  return `${leg}をGoogleマップで開く`;
}

export function resultExtraWalk(duration: string): string {
  return `+${duration} 多く歩ける`;
}

export function resultStandardDetail(arrival: string, walkMinutes: number): string {
  return `ふつうの乗換：${arrival} 着（徒歩 ${walkMinutes}分）`;
}
