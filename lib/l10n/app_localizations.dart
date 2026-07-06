import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_ja.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[Locale('ja')];

  /// アプリタイトル（MaterialApp.title に使用）
  ///
  /// In ja, this message translates to:
  /// **'あるく'**
  String get appTitle;

  /// No description provided for @authErrorInvalidEmail.
  ///
  /// In ja, this message translates to:
  /// **'メールアドレスの形式が正しくありません。'**
  String get authErrorInvalidEmail;

  /// No description provided for @authErrorEmailInUse.
  ///
  /// In ja, this message translates to:
  /// **'このメールアドレスは既に登録されています。'**
  String get authErrorEmailInUse;

  /// No description provided for @authErrorWeakPassword.
  ///
  /// In ja, this message translates to:
  /// **'パスワードは6文字以上で設定してください。'**
  String get authErrorWeakPassword;

  /// No description provided for @authErrorWrongCredentials.
  ///
  /// In ja, this message translates to:
  /// **'メールアドレスまたはパスワードが正しくありません。'**
  String get authErrorWrongCredentials;

  /// No description provided for @authErrorNetwork.
  ///
  /// In ja, this message translates to:
  /// **'ネットワークに接続できませんでした。通信環境をご確認ください。'**
  String get authErrorNetwork;

  /// No description provided for @authErrorTooManyRequests.
  ///
  /// In ja, this message translates to:
  /// **'試行回数が多すぎます。しばらくしてからお試しください。'**
  String get authErrorTooManyRequests;

  /// No description provided for @authErrorUnknown.
  ///
  /// In ja, this message translates to:
  /// **'認証に失敗しました。時間をおいて再度お試しください。'**
  String get authErrorUnknown;

  /// No description provided for @routeErrorNetworkTitle.
  ///
  /// In ja, this message translates to:
  /// **'通信に失敗しました'**
  String get routeErrorNetworkTitle;

  /// No description provided for @routeErrorNetworkDescription.
  ///
  /// In ja, this message translates to:
  /// **'通信状況を確認してもう一度お試しください'**
  String get routeErrorNetworkDescription;

  /// No description provided for @routeErrorNoResultsTitle.
  ///
  /// In ja, this message translates to:
  /// **'ルートが見つかりませんでした'**
  String get routeErrorNoResultsTitle;

  /// No description provided for @routeErrorNoResultsDescription.
  ///
  /// In ja, this message translates to:
  /// **'目的地や出発・到着時刻を変えてお試しください'**
  String get routeErrorNoResultsDescription;

  /// No description provided for @routeErrorNoLocationTitle.
  ///
  /// In ja, this message translates to:
  /// **'現在地を取得できませんでした'**
  String get routeErrorNoLocationTitle;

  /// No description provided for @routeErrorNoLocationDescription.
  ///
  /// In ja, this message translates to:
  /// **'位置情報を有効にしてもう一度お試しください'**
  String get routeErrorNoLocationDescription;

  /// No description provided for @routeErrorNoDestinationTitle.
  ///
  /// In ja, this message translates to:
  /// **'目的地が選ばれていません'**
  String get routeErrorNoDestinationTitle;

  /// No description provided for @routeErrorNoDestinationDescription.
  ///
  /// In ja, this message translates to:
  /// **'目的地を選んでもう一度検索してください'**
  String get routeErrorNoDestinationDescription;

  /// No description provided for @routeErrorUnknownTitle.
  ///
  /// In ja, this message translates to:
  /// **'ルートを取得できませんでした'**
  String get routeErrorUnknownTitle;

  /// No description provided for @routeErrorUnknownDescription.
  ///
  /// In ja, this message translates to:
  /// **'時間をおいてもう一度お試しください'**
  String get routeErrorUnknownDescription;

  /// No description provided for @authLoginTitle.
  ///
  /// In ja, this message translates to:
  /// **'ログイン'**
  String get authLoginTitle;

  /// No description provided for @authSignUpTitle.
  ///
  /// In ja, this message translates to:
  /// **'アカウント作成'**
  String get authSignUpTitle;

  /// No description provided for @authLoginSubtitle.
  ///
  /// In ja, this message translates to:
  /// **'メールアドレスでログインします。'**
  String get authLoginSubtitle;

  /// No description provided for @authSignUpSubtitle.
  ///
  /// In ja, this message translates to:
  /// **'メールアドレスで新しいアカウントを作成します。'**
  String get authSignUpSubtitle;

  /// No description provided for @authEmailHint.
  ///
  /// In ja, this message translates to:
  /// **'メールアドレス'**
  String get authEmailHint;

  /// No description provided for @authPasswordHint.
  ///
  /// In ja, this message translates to:
  /// **'パスワード'**
  String get authPasswordHint;

  /// No description provided for @authSignUpButton.
  ///
  /// In ja, this message translates to:
  /// **'登録する'**
  String get authSignUpButton;

  /// No description provided for @authToggleToSignUp.
  ///
  /// In ja, this message translates to:
  /// **'アカウントをお持ちでない方はこちら'**
  String get authToggleToSignUp;

  /// No description provided for @authToggleToLogin.
  ///
  /// In ja, this message translates to:
  /// **'既にアカウントをお持ちの方はこちら'**
  String get authToggleToLogin;

  /// No description provided for @authOrDivider.
  ///
  /// In ja, this message translates to:
  /// **'または'**
  String get authOrDivider;

  /// No description provided for @authContinueAsGuest.
  ///
  /// In ja, this message translates to:
  /// **'ゲストとして続ける'**
  String get authContinueAsGuest;

  /// No description provided for @authValidationEmptyFields.
  ///
  /// In ja, this message translates to:
  /// **'メールアドレスとパスワードを入力してください。'**
  String get authValidationEmptyFields;

  /// No description provided for @weekdayMon.
  ///
  /// In ja, this message translates to:
  /// **'月'**
  String get weekdayMon;

  /// No description provided for @weekdayTue.
  ///
  /// In ja, this message translates to:
  /// **'火'**
  String get weekdayTue;

  /// No description provided for @weekdayWed.
  ///
  /// In ja, this message translates to:
  /// **'水'**
  String get weekdayWed;

  /// No description provided for @weekdayThu.
  ///
  /// In ja, this message translates to:
  /// **'木'**
  String get weekdayThu;

  /// No description provided for @weekdayFri.
  ///
  /// In ja, this message translates to:
  /// **'金'**
  String get weekdayFri;

  /// No description provided for @weekdaySat.
  ///
  /// In ja, this message translates to:
  /// **'土'**
  String get weekdaySat;

  /// No description provided for @weekdaySun.
  ///
  /// In ja, this message translates to:
  /// **'日'**
  String get weekdaySun;

  /// No description provided for @greetingMorning.
  ///
  /// In ja, this message translates to:
  /// **'おはようございます'**
  String get greetingMorning;

  /// No description provided for @greetingAfternoon.
  ///
  /// In ja, this message translates to:
  /// **'こんにちは'**
  String get greetingAfternoon;

  /// No description provided for @greetingEvening.
  ///
  /// In ja, this message translates to:
  /// **'こんばんは'**
  String get greetingEvening;

  /// No description provided for @dateMonthDayLabel.
  ///
  /// In ja, this message translates to:
  /// **'{month}月{day}日'**
  String dateMonthDayLabel(int month, int day);

  /// No description provided for @homeGreetingLead.
  ///
  /// In ja, this message translates to:
  /// **'今日も、'**
  String get homeGreetingLead;

  /// No description provided for @homeGreetingHighlight.
  ///
  /// In ja, this message translates to:
  /// **'歩こう。'**
  String get homeGreetingHighlight;

  /// No description provided for @homeTimeSectionLabel.
  ///
  /// In ja, this message translates to:
  /// **'時間'**
  String get homeTimeSectionLabel;

  /// No description provided for @homeWalkableSuffix.
  ///
  /// In ja, this message translates to:
  /// **' 歩ける'**
  String get homeWalkableSuffix;

  /// No description provided for @homeDepartureLabel.
  ///
  /// In ja, this message translates to:
  /// **'出発'**
  String get homeDepartureLabel;

  /// No description provided for @homeArrivalLabel.
  ///
  /// In ja, this message translates to:
  /// **'到着'**
  String get homeArrivalLabel;

  /// No description provided for @homeDestinationLabel.
  ///
  /// In ja, this message translates to:
  /// **'目的地'**
  String get homeDestinationLabel;

  /// No description provided for @homeRefreshLocation.
  ///
  /// In ja, this message translates to:
  /// **'現在地を再取得'**
  String get homeRefreshLocation;

  /// No description provided for @homeDestinationPlaceholder.
  ///
  /// In ja, this message translates to:
  /// **'どこへ歩く?'**
  String get homeDestinationPlaceholder;

  /// No description provided for @homeSearchDestination.
  ///
  /// In ja, this message translates to:
  /// **'目的地を検索'**
  String get homeSearchDestination;

  /// No description provided for @homeWeeklyGoal.
  ///
  /// In ja, this message translates to:
  /// **'今週の目標 {goalKm}km'**
  String homeWeeklyGoal(String goalKm);

  /// No description provided for @homeToday.
  ///
  /// In ja, this message translates to:
  /// **'今日'**
  String get homeToday;

  /// No description provided for @homeStepsUnit.
  ///
  /// In ja, this message translates to:
  /// **'歩 ·'**
  String get homeStepsUnit;

  /// No description provided for @homeStreakDays.
  ///
  /// In ja, this message translates to:
  /// **'{days}日連続'**
  String homeStreakDays(int days);

  /// No description provided for @homeSearchRoute.
  ///
  /// In ja, this message translates to:
  /// **'ルートを検索'**
  String get homeSearchRoute;

  /// No description provided for @homeChooseDestination.
  ///
  /// In ja, this message translates to:
  /// **'目的地を選ぶ'**
  String get homeChooseDestination;

  /// No description provided for @searchErrorWithStatus.
  ///
  /// In ja, this message translates to:
  /// **'検索できませんでした ({status})'**
  String searchErrorWithStatus(String status);

  /// No description provided for @searchErrorGeneric.
  ///
  /// In ja, this message translates to:
  /// **'検索できませんでした'**
  String get searchErrorGeneric;

  /// No description provided for @searchNetworkHint.
  ///
  /// In ja, this message translates to:
  /// **'通信状況を確認してください'**
  String get searchNetworkHint;

  /// No description provided for @searchEmptyTitle.
  ///
  /// In ja, this message translates to:
  /// **'候補が見つかりませんでした'**
  String get searchEmptyTitle;

  /// No description provided for @searchEmptyHint.
  ///
  /// In ja, this message translates to:
  /// **'別のキーワードで試してください'**
  String get searchEmptyHint;

  /// No description provided for @searchOriginHint.
  ///
  /// In ja, this message translates to:
  /// **'出発地を検索'**
  String get searchOriginHint;

  /// No description provided for @searchDestinationHint.
  ///
  /// In ja, this message translates to:
  /// **'目的地を検索'**
  String get searchDestinationHint;

  /// No description provided for @searchNearbyToggle.
  ///
  /// In ja, this message translates to:
  /// **'近くの店'**
  String get searchNearbyToggle;

  /// No description provided for @searchPickFailedOrigin.
  ///
  /// In ja, this message translates to:
  /// **'この出発地は位置情報を取得できませんでした。別の候補を選んでください'**
  String get searchPickFailedOrigin;

  /// No description provided for @searchPickFailedDestination.
  ///
  /// In ja, this message translates to:
  /// **'この目的地は位置情報を取得できませんでした。別の候補を選んでください'**
  String get searchPickFailedDestination;

  /// No description provided for @searchUseCurrentLocation.
  ///
  /// In ja, this message translates to:
  /// **'現在地を使う'**
  String get searchUseCurrentLocation;

  /// No description provided for @searchFavoritesSectionTitle.
  ///
  /// In ja, this message translates to:
  /// **'お気に入り'**
  String get searchFavoritesSectionTitle;

  /// No description provided for @searchRecentOrigins.
  ///
  /// In ja, this message translates to:
  /// **'最近の出発地'**
  String get searchRecentOrigins;

  /// No description provided for @searchRecentDestinations.
  ///
  /// In ja, this message translates to:
  /// **'最近の目的地'**
  String get searchRecentDestinations;

  /// No description provided for @searchClearHistory.
  ///
  /// In ja, this message translates to:
  /// **'履歴を消去'**
  String get searchClearHistory;

  /// No description provided for @searchCurrentLocationName.
  ///
  /// In ja, this message translates to:
  /// **'現在地'**
  String get searchCurrentLocationName;

  /// No description provided for @pickerCancel.
  ///
  /// In ja, this message translates to:
  /// **'キャンセル'**
  String get pickerCancel;

  /// No description provided for @pickerDone.
  ///
  /// In ja, this message translates to:
  /// **'完了'**
  String get pickerDone;

  /// No description provided for @pickerNow.
  ///
  /// In ja, this message translates to:
  /// **'現在時刻'**
  String get pickerNow;

  /// No description provided for @resultNoRouteMessage.
  ///
  /// In ja, this message translates to:
  /// **'ルートがありません'**
  String get resultNoRouteMessage;

  /// No description provided for @resultBackToSearch.
  ///
  /// In ja, this message translates to:
  /// **'検索に戻る'**
  String get resultBackToSearch;

  /// No description provided for @resultDepartureLabel.
  ///
  /// In ja, this message translates to:
  /// **'{dateLabel} · {time} 出発'**
  String resultDepartureLabel(String dateLabel, String time);

  /// No description provided for @resultOverBudgetTitle.
  ///
  /// In ja, this message translates to:
  /// **'制限時間を{overMin}分超過しています'**
  String resultOverBudgetTitle(int overMin);

  /// No description provided for @resultOverBudgetHint.
  ///
  /// In ja, this message translates to:
  /// **'時間内に到達できる経路がないため、最短の経路を表示しています'**
  String get resultOverBudgetHint;

  /// No description provided for @resultChangeConditions.
  ///
  /// In ja, this message translates to:
  /// **'条件を変更'**
  String get resultChangeConditions;

  /// No description provided for @resultWalkThisRoute.
  ///
  /// In ja, this message translates to:
  /// **'このルートで歩く'**
  String get resultWalkThisRoute;

  /// No description provided for @resultHourUnit.
  ///
  /// In ja, this message translates to:
  /// **'時間'**
  String get resultHourUnit;

  /// No description provided for @resultMinuteUnit.
  ///
  /// In ja, this message translates to:
  /// **'分'**
  String get resultMinuteUnit;

  /// No description provided for @resultMetricDuration.
  ///
  /// In ja, this message translates to:
  /// **'所要時間'**
  String get resultMetricDuration;

  /// No description provided for @resultMetricWalkDistance.
  ///
  /// In ja, this message translates to:
  /// **'徒歩距離'**
  String get resultMetricWalkDistance;

  /// No description provided for @resultMetricCalories.
  ///
  /// In ja, this message translates to:
  /// **'消費カロリー'**
  String get resultMetricCalories;

  /// No description provided for @resultWalkRatioLabel.
  ///
  /// In ja, this message translates to:
  /// **'距離の {percent}% を歩いて移動'**
  String resultWalkRatioLabel(int percent);

  /// No description provided for @resultBudgetSummary.
  ///
  /// In ja, this message translates to:
  /// **'制限 {budget}のうち {total} で到着 · {slack}分 余裕'**
  String resultBudgetSummary(String budget, String total, int slack);

  /// No description provided for @resultWalkLabel.
  ///
  /// In ja, this message translates to:
  /// **'徒歩'**
  String get resultWalkLabel;

  /// No description provided for @resultTrainDefaultLabel.
  ///
  /// In ja, this message translates to:
  /// **'電車'**
  String get resultTrainDefaultLabel;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['ja'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'ja':
      return AppLocalizationsJa();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
