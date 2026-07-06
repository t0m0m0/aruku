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
