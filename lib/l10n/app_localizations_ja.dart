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
}
