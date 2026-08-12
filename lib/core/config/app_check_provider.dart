/// App Check でデバッグプロバイダを使うかを判定する。
///
/// release を対象に含めれば profile を焼き直さずに済むが、App Store 提出物へ
/// バイパス経路が混入し得るため対象外にしている。profile は提出できないため、
/// 「配布物には入り得ない」という構造的な安全境界になる。トークン必須なのも
/// 同じ理由で、明示的に渡さない限りバイパスは有効化されない。#297 参照。
bool useDebugAppCheckProvider({
  required bool isDebugBuild,
  required bool isProfileBuild,
  required String debugToken,
}) {
  if (isDebugBuild) return true;
  return isProfileBuild && debugToken.trim().isNotEmpty;
}

/// Web で App Check を有効化できるか。
///
/// Web だけ「有効化しない」選択肢があるのは、providerWeb を渡さない `activate` が
/// 'No attestation provider was specified' で同期的に throw し、await 先で未捕捉に
/// なってアプリごと起動しないため。Android / Apple は必ず既定プロバイダを渡せる。
///
/// debug / profile は `WebDebugProvider` で賄える——トークン未指定でも Firebase JS
/// SDK が自動生成してコンソールへ出す（それを Console に登録する）。release は
/// reCAPTCHA のサイトキーが無いとプロバイダを構築できないため有効化を見送る。
/// 見送った場合プロキシは 401 を返す（＝安全側）。#359 参照。
bool canActivateWebAppCheck({
  required bool usesDebugProvider,
  required String recaptchaSiteKey,
}) => usesDebugProvider || recaptchaSiteKey.trim().isNotEmpty;
