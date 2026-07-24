// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Japanese (`ja`).
class AppLocalizationsJa extends AppLocalizations {
  AppLocalizationsJa([String locale = 'ja']) : super(locale);

  @override
  String get appTitle => 'あるく';

  @override
  String get routeErrorNetworkTitle => '通信に失敗しました';

  @override
  String get routeErrorNetworkDescription => '通信状況を確認してもう一度お試しください';

  @override
  String get routeErrorTimeoutTitle => '経路サービスの応答が遅れています';

  @override
  String get routeErrorTimeoutDescription => '混み合っているようです。少し時間をおいてもう一度お試しください';

  @override
  String get routeErrorNoResultsTitle => 'ルートが見つかりませんでした';

  @override
  String get routeErrorNoResultsDescription => '目的地や出発・到着時刻を変えてお試しください';

  @override
  String get routeErrorNoLocationTitle => '現在地を取得できませんでした';

  @override
  String get routeErrorNoLocationDescription => '位置情報を有効にしてもう一度お試しください';

  @override
  String get routeErrorNoDestinationTitle => '目的地が選ばれていません';

  @override
  String get routeErrorNoDestinationDescription => '目的地を選んでもう一度検索してください';

  @override
  String get routeErrorUnknownTitle => 'ルートを取得できませんでした';

  @override
  String get routeErrorUnknownDescription => '時間をおいてもう一度お試しください';

  @override
  String get weekdayMon => '月';

  @override
  String get weekdayTue => '火';

  @override
  String get weekdayWed => '水';

  @override
  String get weekdayThu => '木';

  @override
  String get weekdayFri => '金';

  @override
  String get weekdaySat => '土';

  @override
  String get weekdaySun => '日';

  @override
  String get greetingMorning => 'おはようございます';

  @override
  String get greetingAfternoon => 'こんにちは';

  @override
  String get greetingEvening => 'こんばんは';

  @override
  String dateMonthDayLabel(int month, int day) {
    return '$month月$day日';
  }

  @override
  String get homeGreetingLead => '今日も、';

  @override
  String get homeGreetingHighlight => '歩こう。';

  @override
  String get homeTimeSectionLabel => '時間';

  @override
  String get homeWalkableSuffix => ' 歩ける';

  @override
  String get homeDepartureLabel => '出発';

  @override
  String get homeArrivalLabel => '到着';

  @override
  String get homeDestinationLabel => '目的地';

  @override
  String get homeRefreshLocation => '現在地を再取得';

  @override
  String get homeDestinationPlaceholder => 'どこへ歩く?';

  @override
  String get homeSearchDestination => '目的地を検索';

  @override
  String homeWeeklyGoal(String goalKm) {
    return '今週の目標 ${goalKm}km';
  }

  @override
  String get homeToday => '今日';

  @override
  String get homeStepsUnit => '歩 ·';

  @override
  String homeStreakDays(int days) {
    return '$days日連続';
  }

  @override
  String get homeSearchRoute => 'ルートを検索';

  @override
  String get homeChooseDestination => '目的地を選ぶ';

  @override
  String searchErrorWithStatus(String status) {
    return '検索できませんでした ($status)';
  }

  @override
  String get searchErrorGeneric => '検索できませんでした';

  @override
  String get searchNetworkHint => '通信状況を確認してください';

  @override
  String get searchEmptyTitle => '候補が見つかりませんでした';

  @override
  String get searchEmptyHint => '別のキーワードで試してください';

  @override
  String get searchOriginHint => '出発地を検索';

  @override
  String get searchDestinationHint => '目的地を検索';

  @override
  String get searchNearbyToggle => '近くの店';

  @override
  String get searchPickFailedOrigin => 'この出発地は位置情報を取得できませんでした。別の候補を選んでください';

  @override
  String get searchPickFailedDestination =>
      'この目的地は位置情報を取得できませんでした。別の候補を選んでください';

  @override
  String get searchUseCurrentLocation => '現在地を使う';

  @override
  String get searchRecentOrigins => '最近の出発地';

  @override
  String get searchRecentDestinations => '最近の目的地';

  @override
  String get searchClearHistory => '履歴を消去';

  @override
  String get searchCurrentLocationName => '現在地';

  @override
  String get pickerCancel => 'キャンセル';

  @override
  String get pickerDone => '完了';

  @override
  String get pickerNow => '現在時刻';

  @override
  String get resultNoRouteMessage => 'ルートがありません';

  @override
  String get resultBackToSearch => '検索に戻る';

  @override
  String resultDepartureLabel(String dateLabel, String time) {
    return '$dateLabel · $time 出発';
  }

  @override
  String resultOverBudgetTitle(int overMin) {
    return '制限時間を$overMin分超過しています';
  }

  @override
  String get resultOverBudgetHint => '時間内に到達できる経路がないため、最短の経路を表示しています';

  @override
  String get resultChangeConditions => '条件を変更';

  @override
  String get resultCtaWalkToDestination => 'Googleマップで徒歩ルートを開く';

  @override
  String get resultCtaTransitToDestination => 'Googleマップで乗換案内を開く';

  @override
  String get resultCtaLaunchFailed => 'Google Mapsを開けませんでした';

  @override
  String get resultCtaMarkLegComplete => 'この区間を完了';

  @override
  String get resultJourneyCompleteMessage => '目的地に到着しました';

  @override
  String get resultLegDoneLabel => '完了';

  @override
  String get resultLegCurrentLabel => '進行中';

  @override
  String get resultHourUnit => '時間';

  @override
  String get resultMinuteUnit => '分';

  @override
  String get resultMetricDuration => '所要時間';

  @override
  String get resultMetricWalkDistance => '徒歩距離';

  @override
  String get resultMetricCalories => '消費カロリー';

  @override
  String resultWalkRatioLabel(int percent) {
    return '距離の $percent% を歩いて移動';
  }

  @override
  String resultBudgetSummary(
    String budget,
    String total,
    int slackMinutes,
    String slackKind,
  ) {
    String _temp0 = intl.Intl.selectLogic(slackKind, {
      'over': '超過',
      'other': '余裕',
    });
    return '制限 $budgetのうち $total で到着 · $slackMinutes分 $_temp0';
  }

  @override
  String get resultWalkLabel => '徒歩';

  @override
  String get resultTrainDefaultLabel => '電車';

  @override
  String get resultBusDefaultLabel => 'バス';

  @override
  String get resultShareButton => 'ルートを共有';

  @override
  String get resultAlternativesTitle => '他の候補';

  @override
  String resultAlternativeSummary(
    int walkMin,
    String arrival,
    int transferCount,
  ) {
    return '徒歩$walkMin分 · 到着 $arrival · 乗換$transferCount回';
  }

  @override
  String resultAlternativeArrivalFallback(int minutes) {
    return '+$minutes分';
  }

  @override
  String resultShareText(String from, String to, String walkKm, int kcal) {
    return '$from → $to を歩くルート🚶\n徒歩${walkKm}km・${kcal}kcal\n#アルク #ウォーキング';
  }

  @override
  String get onboardCoreTitleLead => '電車はなるべく、\n';

  @override
  String get onboardCoreTitleHighlight => '乗らない';

  @override
  String get onboardCoreDescription => '時間内に着く範囲で、\nいちばん歩けるルートを案内します。';

  @override
  String get onboardHowToTitleLead => '着く時間を、\n';

  @override
  String get onboardHowToTitleHighlight => '指定するだけ';

  @override
  String get onboardHowToDescription => 'あとはアプリが、間に合う範囲で\nいちばん歩けるルートを選びます。';

  @override
  String get onboardHowToFeatureTitle => '到着時刻をセット';

  @override
  String get onboardHowToFeatureSubtitle => '出発／到着のどちらでも指定できます';

  @override
  String get onboardRecordTitleLead => 'あなたの歩みを、\n';

  @override
  String get onboardRecordTitleHighlight => '記録する';

  @override
  String get onboardRecordDescription => '歩数・距離・消費カロリーを記録して、\n続けた歩みを可視化します。';

  @override
  String get onboardRecordFeatureTitle => '毎日の歩みを記録';

  @override
  String get onboardRecordFeatureSubtitle => '歩数・距離・カロリーをまとめて確認';

  @override
  String get onboardStart => 'はじめる';

  @override
  String get onboardNext => '次へ';

  @override
  String get onboardTermsNotice => '続行で利用規約とプライバシーに同意したことになります';

  @override
  String get onboardWeeklyKcalLead => '最初の1週間で';

  @override
  String get onboardWeeklyKcalTrailer => '通勤を歩くだけで';

  @override
  String get settingsTitle => '設定';

  @override
  String get settingsNotificationsSection => '通知';

  @override
  String get settingsReceiveNotifications => '通知を受け取る';

  @override
  String get notificationStreakReminderTitle => '連続記録が途切れそうです';

  @override
  String notificationStreakReminderBody(int days) {
    return '$days日つづいた連続記録が今日で途切れそうです。少し歩きませんか？';
  }

  @override
  String get settingsWeeklyGoalSection => '週間目標';

  @override
  String get settingsWeeklyGoalLabel => '1週間の目標距離';

  @override
  String settingsWeeklyGoalValue(String km) {
    return '${km}km';
  }

  @override
  String get settingsPermissionsSection => '権限';

  @override
  String get settingsLocationNotificationPermission => '位置情報・通知の権限';

  @override
  String get settingsOpenDeviceSettings => '端末設定を開く';

  @override
  String get settingsHealthKitSection => 'ヘルスケア連携';

  @override
  String get settingsHealthKitEnable => 'ウォーキングを記録する';

  @override
  String get settingsHealthKitDescription =>
      'オンにすると、歩行ナビの記録をヘルスケアにワークアウトとして保存します。';

  @override
  String get settingsSaveFailed => '設定を保存できませんでした';

  @override
  String get settingsLegalSection => '法的情報';

  @override
  String get settingsTermsOfService => '利用規約';

  @override
  String get settingsPrivacyPolicy => 'プライバシーポリシー';

  @override
  String get settingsLinkOpenFailed => 'リンクを開けませんでした';

  @override
  String get errorRetry => '再試行';

  @override
  String loadingDestinationBudget(String dest, String budget) {
    return '$dest まで · 制限 $budget';
  }

  @override
  String loadingBudgetOnly(String budget) {
    return '制限 $budget';
  }

  @override
  String get loadingSearchingMessage => '歩ける道を、探しています';

  @override
  String get loadingCancelButton => 'キャンセル';

  @override
  String get commonBack => '戻る';

  @override
  String get homeOpenSettings => '設定を開く';

  @override
  String get searchClearInput => '入力を消去';
}
