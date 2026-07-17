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
