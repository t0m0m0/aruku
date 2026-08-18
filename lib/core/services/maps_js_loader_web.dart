/// Web 向けの実体。`package:web` を使わないのは、transitive 依存でしか無く、
/// 直接使うと `depend_on_referenced_packages` で `dart analyze --fatal-infos` が
/// 落ちるため。宣言を自前で持てば新規依存の追加が要らない。
library;

import 'dart:async';
import 'dart:js_interop';

@JS('document')
external _Document get _document;

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

Future<bool> loadMapsJs(String url) {
  final completer = Completer<bool>();
  final script = _document.createElement('script')
    ..src = url
    ..isAsync = true
    ..onload = (() => completer.complete(true)).toJS
    ..onerror = (() => completer.complete(false)).toJS;
  _document.head.appendChild(script);
  return completer.future;
}
