/// Web 以外向けの実体。
///
/// 呼ばれることはない（`loadMapsJsIfNeeded` が `isWeb` で弾く）が、条件付き
/// import は VM 側にも同じシンボルを要求する。`dart:js_interop` は VM に無いため
/// 実装を分けている——`dart:io` と違いスタブが提供されないので、`kIsWeb` 分岐では
/// コンパイルが通らない。
library;

Future<bool> loadMapsJs(String url) async => false;
