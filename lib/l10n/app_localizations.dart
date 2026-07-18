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

  /// No description provided for @routeErrorTimeoutTitle.
  ///
  /// In ja, this message translates to:
  /// **'経路サービスの応答が遅れています'**
  String get routeErrorTimeoutTitle;

  /// No description provided for @routeErrorTimeoutDescription.
  ///
  /// In ja, this message translates to:
  /// **'混み合っているようです。少し時間をおいてもう一度お試しください'**
  String get routeErrorTimeoutDescription;

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

  /// No description provided for @resultCtaWalkToDestination.
  ///
  /// In ja, this message translates to:
  /// **'Google Mapsで{destination}まで歩く'**
  String resultCtaWalkToDestination(String destination);

  /// No description provided for @resultCtaTransitToDestination.
  ///
  /// In ja, this message translates to:
  /// **'Google Mapsで{destination}まで行く'**
  String resultCtaTransitToDestination(String destination);

  /// No description provided for @resultCtaLaunchFailed.
  ///
  /// In ja, this message translates to:
  /// **'Google Mapsを開けませんでした'**
  String get resultCtaLaunchFailed;

  /// No description provided for @resultCtaMarkLegComplete.
  ///
  /// In ja, this message translates to:
  /// **'この区間を完了'**
  String get resultCtaMarkLegComplete;

  /// No description provided for @resultJourneyCompleteMessage.
  ///
  /// In ja, this message translates to:
  /// **'目的地に到着しました'**
  String get resultJourneyCompleteMessage;

  /// No description provided for @resultLegDoneLabel.
  ///
  /// In ja, this message translates to:
  /// **'完了'**
  String get resultLegDoneLabel;

  /// No description provided for @resultLegCurrentLabel.
  ///
  /// In ja, this message translates to:
  /// **'進行中'**
  String get resultLegCurrentLabel;

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
  /// **'制限 {budget}のうち {total} で到着 · {slackMinutes}分 {slackKind, select, over{超過} other{余裕}}'**
  String resultBudgetSummary(
    String budget,
    String total,
    int slackMinutes,
    String slackKind,
  );

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

  /// No description provided for @resultBusDefaultLabel.
  ///
  /// In ja, this message translates to:
  /// **'バス'**
  String get resultBusDefaultLabel;

  /// No description provided for @resultShareButton.
  ///
  /// In ja, this message translates to:
  /// **'ルートを共有'**
  String get resultShareButton;

  /// No description provided for @resultAlternativesTitle.
  ///
  /// In ja, this message translates to:
  /// **'他の候補'**
  String get resultAlternativesTitle;

  /// No description provided for @resultAlternativeSummary.
  ///
  /// In ja, this message translates to:
  /// **'徒歩{walkMin}分 · 到着 {arrival} · 乗換{transferCount}回'**
  String resultAlternativeSummary(
    int walkMin,
    String arrival,
    int transferCount,
  );

  /// No description provided for @resultAlternativeArrivalFallback.
  ///
  /// In ja, this message translates to:
  /// **'+{minutes}分'**
  String resultAlternativeArrivalFallback(int minutes);

  /// No description provided for @resultShareText.
  ///
  /// In ja, this message translates to:
  /// **'{from} → {to} を歩くルート🚶\n徒歩{walkKm}km・{kcal}kcal\n#アルク #ウォーキング'**
  String resultShareText(String from, String to, String walkKm, int kcal);

  /// No description provided for @navFinishButton.
  ///
  /// In ja, this message translates to:
  /// **'歩き終わった'**
  String get navFinishButton;

  /// No description provided for @completeTitle.
  ///
  /// In ja, this message translates to:
  /// **'歩き切りました！'**
  String get completeTitle;

  /// No description provided for @completeShareButton.
  ///
  /// In ja, this message translates to:
  /// **'記録をシェア'**
  String get completeShareButton;

  /// No description provided for @completeHomeButton.
  ///
  /// In ja, this message translates to:
  /// **'ホームに戻る'**
  String get completeHomeButton;

  /// No description provided for @completeShareText.
  ///
  /// In ja, this message translates to:
  /// **'{distanceKm}km 歩きました！（{kcal}kcal）\n#アルク #ウォーキング #おさんぽ'**
  String completeShareText(String distanceKm, int kcal);

  /// No description provided for @shareCardHashtags.
  ///
  /// In ja, this message translates to:
  /// **'#アルク #ウォーキング'**
  String get shareCardHashtags;

  /// No description provided for @shareErrorMessage.
  ///
  /// In ja, this message translates to:
  /// **'共有できませんでした。もう一度お試しください'**
  String get shareErrorMessage;

  /// No description provided for @navConfirmExitTitle.
  ///
  /// In ja, this message translates to:
  /// **'ナビを終了しますか？'**
  String get navConfirmExitTitle;

  /// No description provided for @navExit.
  ///
  /// In ja, this message translates to:
  /// **'終了'**
  String get navExit;

  /// No description provided for @navRecenterButton.
  ///
  /// In ja, this message translates to:
  /// **'現在地に戻る'**
  String get navRecenterButton;

  /// No description provided for @navToggleMapType.
  ///
  /// In ja, this message translates to:
  /// **'地図の種別を切り替える'**
  String get navToggleMapType;

  /// No description provided for @navResetNorth.
  ///
  /// In ja, this message translates to:
  /// **'地図を北向きに戻す'**
  String get navResetNorth;

  /// No description provided for @navManeuverStraight.
  ///
  /// In ja, this message translates to:
  /// **'直進'**
  String get navManeuverStraight;

  /// No description provided for @navManeuverSlightLeft.
  ///
  /// In ja, this message translates to:
  /// **'斜め左'**
  String get navManeuverSlightLeft;

  /// No description provided for @navManeuverSlightRight.
  ///
  /// In ja, this message translates to:
  /// **'斜め右'**
  String get navManeuverSlightRight;

  /// No description provided for @navManeuverLeft.
  ///
  /// In ja, this message translates to:
  /// **'左折'**
  String get navManeuverLeft;

  /// No description provided for @navManeuverRight.
  ///
  /// In ja, this message translates to:
  /// **'右折'**
  String get navManeuverRight;

  /// No description provided for @navManeuverArrive.
  ///
  /// In ja, this message translates to:
  /// **'まもなく到着'**
  String get navManeuverArrive;

  /// No description provided for @navManeuverBoardGeneric.
  ///
  /// In ja, this message translates to:
  /// **'乗車'**
  String get navManeuverBoardGeneric;

  /// No description provided for @navManeuverAlightGeneric.
  ///
  /// In ja, this message translates to:
  /// **'下車'**
  String get navManeuverAlightGeneric;

  /// No description provided for @navManeuverBoard.
  ///
  /// In ja, this message translates to:
  /// **'{line}に乗車'**
  String navManeuverBoard(String line);

  /// No description provided for @navManeuverAlight.
  ///
  /// In ja, this message translates to:
  /// **'{station}で下車'**
  String navManeuverAlight(String station);

  /// No description provided for @navStationDefault.
  ///
  /// In ja, this message translates to:
  /// **'駅'**
  String get navStationDefault;

  /// No description provided for @navDestinationSuffix.
  ///
  /// In ja, this message translates to:
  /// **'{destination} まで'**
  String navDestinationSuffix(String destination);

  /// No description provided for @navRerouting.
  ///
  /// In ja, this message translates to:
  /// **'ルートを再検索中…'**
  String get navRerouting;

  /// No description provided for @navGpsLost.
  ///
  /// In ja, this message translates to:
  /// **'現在地を取得できません。電波状況の良い場所で再試行します'**
  String get navGpsLost;

  /// No description provided for @navRerouteFailed.
  ///
  /// In ja, this message translates to:
  /// **'再検索に失敗しました。旧ルートを表示中'**
  String get navRerouteFailed;

  /// No description provided for @navRemainingLabel.
  ///
  /// In ja, this message translates to:
  /// **'残り'**
  String get navRemainingLabel;

  /// No description provided for @navRemainingWalkLabel.
  ///
  /// In ja, this message translates to:
  /// **'残り（徒歩）'**
  String get navRemainingWalkLabel;

  /// No description provided for @navRemainingTotalValue.
  ///
  /// In ja, this message translates to:
  /// **'全行程 {km} km'**
  String navRemainingTotalValue(String km);

  /// No description provided for @navConsumedLabel.
  ///
  /// In ja, this message translates to:
  /// **'消費'**
  String get navConsumedLabel;

  /// No description provided for @navPendingFix.
  ///
  /// In ja, this message translates to:
  /// **'取得中'**
  String get navPendingFix;

  /// No description provided for @onboardCoreTitleLead.
  ///
  /// In ja, this message translates to:
  /// **'電車はなるべく、\n'**
  String get onboardCoreTitleLead;

  /// No description provided for @onboardCoreTitleHighlight.
  ///
  /// In ja, this message translates to:
  /// **'乗らない'**
  String get onboardCoreTitleHighlight;

  /// No description provided for @onboardCoreDescription.
  ///
  /// In ja, this message translates to:
  /// **'時間内に着く範囲で、\nいちばん歩けるルートを案内します。'**
  String get onboardCoreDescription;

  /// No description provided for @onboardHowToTitleLead.
  ///
  /// In ja, this message translates to:
  /// **'着く時間を、\n'**
  String get onboardHowToTitleLead;

  /// No description provided for @onboardHowToTitleHighlight.
  ///
  /// In ja, this message translates to:
  /// **'指定するだけ'**
  String get onboardHowToTitleHighlight;

  /// No description provided for @onboardHowToDescription.
  ///
  /// In ja, this message translates to:
  /// **'あとはアプリが、間に合う範囲で\nいちばん歩けるルートを選びます。'**
  String get onboardHowToDescription;

  /// No description provided for @onboardHowToFeatureTitle.
  ///
  /// In ja, this message translates to:
  /// **'到着時刻をセット'**
  String get onboardHowToFeatureTitle;

  /// No description provided for @onboardHowToFeatureSubtitle.
  ///
  /// In ja, this message translates to:
  /// **'出発／到着のどちらでも指定できます'**
  String get onboardHowToFeatureSubtitle;

  /// No description provided for @onboardRecordTitleLead.
  ///
  /// In ja, this message translates to:
  /// **'あなたの歩みを、\n'**
  String get onboardRecordTitleLead;

  /// No description provided for @onboardRecordTitleHighlight.
  ///
  /// In ja, this message translates to:
  /// **'記録する'**
  String get onboardRecordTitleHighlight;

  /// No description provided for @onboardRecordDescription.
  ///
  /// In ja, this message translates to:
  /// **'歩数・距離・消費カロリーを記録して、\n続けた歩みを可視化します。'**
  String get onboardRecordDescription;

  /// No description provided for @onboardRecordFeatureTitle.
  ///
  /// In ja, this message translates to:
  /// **'毎日の歩みを記録'**
  String get onboardRecordFeatureTitle;

  /// No description provided for @onboardRecordFeatureSubtitle.
  ///
  /// In ja, this message translates to:
  /// **'歩数・距離・カロリーをまとめて確認'**
  String get onboardRecordFeatureSubtitle;

  /// No description provided for @onboardStart.
  ///
  /// In ja, this message translates to:
  /// **'はじめる'**
  String get onboardStart;

  /// No description provided for @onboardNext.
  ///
  /// In ja, this message translates to:
  /// **'次へ'**
  String get onboardNext;

  /// No description provided for @onboardTermsNotice.
  ///
  /// In ja, this message translates to:
  /// **'続行で利用規約とプライバシーに同意したことになります'**
  String get onboardTermsNotice;

  /// No description provided for @onboardWeeklyKcalLead.
  ///
  /// In ja, this message translates to:
  /// **'最初の1週間で'**
  String get onboardWeeklyKcalLead;

  /// No description provided for @onboardWeeklyKcalTrailer.
  ///
  /// In ja, this message translates to:
  /// **'通勤を歩くだけで'**
  String get onboardWeeklyKcalTrailer;

  /// No description provided for @settingsTitle.
  ///
  /// In ja, this message translates to:
  /// **'設定'**
  String get settingsTitle;

  /// No description provided for @settingsNotificationsSection.
  ///
  /// In ja, this message translates to:
  /// **'通知'**
  String get settingsNotificationsSection;

  /// No description provided for @settingsReceiveNotifications.
  ///
  /// In ja, this message translates to:
  /// **'通知を受け取る'**
  String get settingsReceiveNotifications;

  /// No description provided for @notificationStreakReminderTitle.
  ///
  /// In ja, this message translates to:
  /// **'連続記録が途切れそうです'**
  String get notificationStreakReminderTitle;

  /// No description provided for @notificationStreakReminderBody.
  ///
  /// In ja, this message translates to:
  /// **'{days}日つづいた連続記録が今日で途切れそうです。少し歩きませんか？'**
  String notificationStreakReminderBody(int days);

  /// No description provided for @settingsWeeklyGoalSection.
  ///
  /// In ja, this message translates to:
  /// **'週間目標'**
  String get settingsWeeklyGoalSection;

  /// No description provided for @settingsWeeklyGoalLabel.
  ///
  /// In ja, this message translates to:
  /// **'1週間の目標距離'**
  String get settingsWeeklyGoalLabel;

  /// No description provided for @settingsWeeklyGoalValue.
  ///
  /// In ja, this message translates to:
  /// **'{km}km'**
  String settingsWeeklyGoalValue(String km);

  /// No description provided for @settingsPermissionsSection.
  ///
  /// In ja, this message translates to:
  /// **'権限'**
  String get settingsPermissionsSection;

  /// No description provided for @settingsLocationNotificationPermission.
  ///
  /// In ja, this message translates to:
  /// **'位置情報・通知の権限'**
  String get settingsLocationNotificationPermission;

  /// No description provided for @settingsOpenDeviceSettings.
  ///
  /// In ja, this message translates to:
  /// **'端末設定を開く'**
  String get settingsOpenDeviceSettings;

  /// No description provided for @settingsHealthKitSection.
  ///
  /// In ja, this message translates to:
  /// **'ヘルスケア連携'**
  String get settingsHealthKitSection;

  /// No description provided for @settingsHealthKitEnable.
  ///
  /// In ja, this message translates to:
  /// **'ウォーキングを記録する'**
  String get settingsHealthKitEnable;

  /// No description provided for @settingsHealthKitDescription.
  ///
  /// In ja, this message translates to:
  /// **'オンにすると、歩行ナビの記録をヘルスケアにワークアウトとして保存します。'**
  String get settingsHealthKitDescription;

  /// No description provided for @settingsSaveFailed.
  ///
  /// In ja, this message translates to:
  /// **'設定を保存できませんでした'**
  String get settingsSaveFailed;

  /// No description provided for @settingsLegalSection.
  ///
  /// In ja, this message translates to:
  /// **'法的情報'**
  String get settingsLegalSection;

  /// No description provided for @settingsTermsOfService.
  ///
  /// In ja, this message translates to:
  /// **'利用規約'**
  String get settingsTermsOfService;

  /// No description provided for @settingsPrivacyPolicy.
  ///
  /// In ja, this message translates to:
  /// **'プライバシーポリシー'**
  String get settingsPrivacyPolicy;

  /// No description provided for @settingsLinkOpenFailed.
  ///
  /// In ja, this message translates to:
  /// **'リンクを開けませんでした'**
  String get settingsLinkOpenFailed;

  /// No description provided for @errorRetry.
  ///
  /// In ja, this message translates to:
  /// **'再試行'**
  String get errorRetry;

  /// No description provided for @loadingDestinationBudget.
  ///
  /// In ja, this message translates to:
  /// **'{dest} まで · 制限 {budget}'**
  String loadingDestinationBudget(String dest, String budget);

  /// No description provided for @loadingBudgetOnly.
  ///
  /// In ja, this message translates to:
  /// **'制限 {budget}'**
  String loadingBudgetOnly(String budget);

  /// No description provided for @loadingSearchingMessage.
  ///
  /// In ja, this message translates to:
  /// **'歩ける道を、探しています'**
  String get loadingSearchingMessage;

  /// No description provided for @loadingCancelButton.
  ///
  /// In ja, this message translates to:
  /// **'キャンセル'**
  String get loadingCancelButton;

  /// 戻るボタンのVoiceOverラベル（各画面ヘッダー共通）
  ///
  /// In ja, this message translates to:
  /// **'戻る'**
  String get commonBack;

  /// ホーム右上の設定ボタンのVoiceOverラベル
  ///
  /// In ja, this message translates to:
  /// **'設定を開く'**
  String get homeOpenSettings;

  /// 検索フィールドのクリアボタンのVoiceOverラベル
  ///
  /// In ja, this message translates to:
  /// **'入力を消去'**
  String get searchClearInput;
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
