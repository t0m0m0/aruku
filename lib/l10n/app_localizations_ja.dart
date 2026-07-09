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
  String get authErrorInvalidEmail => 'メールアドレスの形式が正しくありません。';

  @override
  String get authErrorEmailInUse => 'このメールアドレスは既に登録されています。';

  @override
  String get authErrorWeakPassword => 'パスワードは6文字以上で設定してください。';

  @override
  String get authErrorWrongCredentials => 'メールアドレスまたはパスワードが正しくありません。';

  @override
  String get authErrorNetwork => 'ネットワークに接続できませんでした。通信環境をご確認ください。';

  @override
  String get authErrorTooManyRequests => '試行回数が多すぎます。しばらくしてからお試しください。';

  @override
  String get authErrorUnknown => '認証に失敗しました。時間をおいて再度お試しください。';

  @override
  String get routeErrorNetworkTitle => '通信に失敗しました';

  @override
  String get routeErrorNetworkDescription => '通信状況を確認してもう一度お試しください';

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
  String get authLoginTitle => 'ログイン';

  @override
  String get authSignUpTitle => 'アカウント作成';

  @override
  String get authLoginSubtitle => 'メールアドレスでログインします。';

  @override
  String get authSignUpSubtitle => 'メールアドレスで新しいアカウントを作成します。';

  @override
  String get authEmailHint => 'メールアドレス';

  @override
  String get authPasswordHint => 'パスワード';

  @override
  String get authSignUpButton => '登録する';

  @override
  String get authToggleToSignUp => 'アカウントをお持ちでない方はこちら';

  @override
  String get authToggleToLogin => '既にアカウントをお持ちの方はこちら';

  @override
  String get authOrDivider => 'または';

  @override
  String get authContinueAsGuest => 'ゲストとして続ける';

  @override
  String get authValidationEmptyFields => 'メールアドレスとパスワードを入力してください。';

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
  String get searchFavoritesSectionTitle => 'お気に入り';

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
  String get resultWalkThisRoute => 'このルートで歩く';

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
  String resultBudgetSummary(String budget, String total, int slack) {
    return '制限 $budgetのうち $total で到着 · $slack分 余裕';
  }

  @override
  String get resultWalkLabel => '徒歩';

  @override
  String get resultTrainDefaultLabel => '電車';

  @override
  String get resultShareButton => 'ルートを共有';

  @override
  String resultShareText(String from, String to, String walkKm, int kcal) {
    return '$from → $to を歩くルート🚶\n徒歩${walkKm}km・${kcal}kcal\n#アルク #ウォーキング';
  }

  @override
  String get navFinishButton => '歩き終わった';

  @override
  String get completeTitle => '歩き切りました！';

  @override
  String get completeShareButton => '記録をシェア';

  @override
  String get completeHomeButton => 'ホームに戻る';

  @override
  String completeShareText(String distanceKm, int kcal) {
    return '${distanceKm}km 歩きました！（${kcal}kcal）\n#アルク #ウォーキング #おさんぽ';
  }

  @override
  String get shareCardHashtags => '#アルク #ウォーキング';

  @override
  String get shareErrorMessage => '共有できませんでした。もう一度お試しください';

  @override
  String get navConfirmExitTitle => 'ナビを終了しますか？';

  @override
  String get navExit => '終了';

  @override
  String get navRecenterButton => '現在地に戻る';

  @override
  String get navToggleMapType => '地図の種別を切り替える';

  @override
  String get navResetNorth => '地図を北向きに戻す';

  @override
  String get navManeuverStraight => '直進';

  @override
  String get navManeuverSlightLeft => '斜め左';

  @override
  String get navManeuverSlightRight => '斜め右';

  @override
  String get navManeuverLeft => '左折';

  @override
  String get navManeuverRight => '右折';

  @override
  String get navManeuverArrive => 'まもなく到着';

  @override
  String get navManeuverBoardGeneric => '乗車';

  @override
  String get navManeuverAlightGeneric => '下車';

  @override
  String navManeuverBoard(String line) {
    return '$lineに乗車';
  }

  @override
  String navManeuverAlight(String station) {
    return '$stationで下車';
  }

  @override
  String get navStationDefault => '駅';

  @override
  String navDestinationSuffix(String destination) {
    return '$destination まで';
  }

  @override
  String get navRerouting => 'ルートを再検索中…';

  @override
  String get navGpsLost => '現在地を取得できません。電波状況の良い場所で再試行します';

  @override
  String get navRerouteFailed => '再検索に失敗しました。旧ルートを表示中';

  @override
  String get navRemainingLabel => '残り';

  @override
  String get navRemainingWalkLabel => '残り（徒歩）';

  @override
  String navRemainingTotalValue(String km) {
    return '全行程 $km km';
  }

  @override
  String get navConsumedLabel => '消費';

  @override
  String get navPendingFix => '取得中';

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

  @override
  String get searchRemoveFavorite => 'お気に入りから削除';

  @override
  String get resultAddFavorite => 'お気に入りに追加';

  @override
  String get resultRemoveFavorite => 'お気に入りから削除';
}
