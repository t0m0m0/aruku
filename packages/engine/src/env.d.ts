// ビルド時に差し替わる `import.meta.env` の型。

/// `vite/client` が宣言するものと同じ形を最小限だけ書いている。**その型定義を
/// `tsconfig` の `types` で取り込まない**のは、`vite` が vitest 経由の推移的依存で、
/// 直接の依存として宣言していないため——ホイストや vitest 側のバージョン更新で
/// 解決できなくなると `tsc` が落ちる。インターフェースは宣言マージされるので、
/// Phase 3（#386）のアプリが `vite/client` を取り込んでも衝突しない。
interface ImportMetaEnv {
  /// 開発ビルドか（Dart の `kDebugMode` に対応）。
  readonly DEV: boolean;

  /// 本番ビルドか。profile ビルドもこちらが真になるので、release の判定には
  /// [MODE] と併せて見る（`src/build-mode.ts`）。
  readonly PROD: boolean;

  /// ビルドモード名。`vite build --mode profile` で 'profile' になる。
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
