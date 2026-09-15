/// E2E の配信とビルドで共有する定数。playwright.config.ts（ビルドへ渡す env）と
/// 偽の上流（page.route の突き合わせ）が同じ値を見る必要がある。

/// プレビューの待ち受けポート。
///
/// 固定するのは、ベース URL が**ビルド時にバンドルへ焼かれる**ため（config.ts の
/// `import.meta.env.VITE_*`）。実行時に決めた番号を後から差し込む口が無い。
/// 空きを探して別の番号で上がると、バンドルが指す先と食い違って「上流が全部 404」
/// という原因から遠い失敗になるので、preview は `--strictPort` で落とす。
export const previewPort = 4173;
export const previewOrigin = `http://localhost:${previewPort}`;

/// 偽の上流の置き場所。プレビューと**同一オリジン**に置く。
///
/// 別オリジン（例 `https://upstream.invalid`）にすると CORS が挟まり、fulfill する
/// 応答へ `Access-Control-*` を載せる話が混ざる。ここで確かめたいのはアプリの配線で
/// あってブラウザの CORS ではない。同一オリジンなら preflight も起きない。
export const proxyBaseUrl = `${previewOrigin}/__e2e/proxy`;
export const transitBaseUrl = `${previewOrigin}/__e2e/transit`;

/// 偽の上流だけが持つパスの前置き。どのハンドラにも当たらなかった要求を
/// 捕まえる網（fake-upstream.ts）がこれで判定する。
export const upstreamPrefix = '/__e2e/';

/// E2E 用ビルドの出力先。`dist/` と分ける——偽の上流を指す URL が焼かれた
/// バンドルなので、配信する成果物と同じ場所に置くと取り違える。
export const previewOutDir = 'dist-e2e';
