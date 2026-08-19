/// Web 向けの実体。`package:web` を使わないのは、transitive 依存でしか無く、
/// 直接使うと `depend_on_referenced_packages` で `dart analyze --fatal-infos` が
/// 落ちるため。宣言を自前で持てば新規依存の追加が要らない。
library;

import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

@JS('document')
external _Document get _document;

@JS('globalThis')
external JSObject get _globalThis;

extension type _Document._(JSObject _) implements JSObject {
  external _ScriptElement createElement(String tagName);
  external _Node get head;
}

extension type _Node._(JSObject _) implements JSObject {
  external void appendChild(JSObject child);
}

extension type _ScriptElement._(JSObject _) implements JSObject {
  external set src(String value);
  @JS('async')
  external set isAsync(bool value);
  external set onload(JSFunction value);
  external set onerror(JSFunction value);
}

/// `google.maps` が既に在るか。
///
/// 2 度目の注入を避けるために見る。同じ API を二重に読み込むと Google 自身が警告を
/// 出し、地図の生成も不安定になる。
bool _mapsApiReady() {
  final google = _globalThis.getProperty<JSAny?>('google'.toJS);
  if (google.isUndefinedOrNull) return false;
  return (google! as JSObject)
      .getProperty<JSAny?>('maps'.toJS)
      .isDefinedAndNotNull;
}

/// 進行中の読み込み。完了したら捨てる。
///
/// 保持するのは、`mapsJsLoadedProvider` が autoDispose で、読み込み中に地図が画面から
/// 消えて再び現れると 2 回目の呼び出しが来るため。そのとき `_mapsApiReady()` はまだ
/// false なので、これが無いと script を二重に注入する（PR #363 レビュー）。
/// 完了後に捨てるのは、失敗した結果を抱え込むと再試行できなくなるから。
Future<bool>? _pending;

Future<bool> loadMapsJs(String url) {
  if (_mapsApiReady()) return Future<bool>.value(true);
  return _pending ??= _inject(url).whenComplete(() => _pending = null);
}

Future<bool> _inject(String url) {
  final completer = Completer<bool>();
  final script = _document.createElement('script')
    ..src = url
    ..isAsync = true
    ..onload = (() => completer.complete(true)).toJS
    ..onerror = (() => completer.complete(false)).toJS;
  _document.head.appendChild(script);
  return completer.future;
}
