import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

/// 外部URLを開く関数。テストでは fake に差し替えて呼び出しURLを検証する。
typedef UrlLauncher = Future<bool> Function(Uri url);

final urlLauncherProvider = Provider<UrlLauncher>(
  (ref) =>
      (url) => launchUrl(url, mode: LaunchMode.externalApplication),
);
