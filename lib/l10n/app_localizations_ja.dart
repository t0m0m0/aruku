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
}
