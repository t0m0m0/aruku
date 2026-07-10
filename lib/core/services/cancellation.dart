/// 検索1回分のキャンセル境界（#259）。ユーザーがローディングを離脱した時点で、
/// 進行中の HTTP を実際に切るために使う。
///
/// [RouteException] と別の型にしているのは、[TransitRouteService] の縮退パス
/// （失敗レッグを直線推定へ落とす `on RouteException`）にキャンセルが吸収されると、
/// キャンセル後も残りのファンアウトが走り続けてしまうため。別型なら素通しで上まで
/// 伝播し、`AppNotifier` の世代ガードが握り潰す。
class SearchCanceledException implements Exception {
  const SearchCanceledException();

  @override
  String toString() => 'SearchCanceledException';
}

/// 一度だけ倒せるフラグと、倒れた瞬間に走らせる後始末の束。
///
/// package:http にはリクエスト単位の abort が無く、in-flight を落とす唯一の手段は
/// `Client.close()`（`IOClient` は `HttpClient.close(force: true)` へ委譲する）。
/// そのため中断は「検索単位で作った client を [onCancel] で閉じる」形で実現する。
class CancellationToken {
  bool _canceled = false;
  final List<void Function()> _callbacks = [];

  bool get isCanceled => _canceled;

  /// キャンセル時に呼ぶ後始末を登録する。既にキャンセル済みなら即座に実行する
  /// （登録と cancel の競合で後始末が取りこぼされないようにするため）。
  void onCancel(void Function() callback) {
    if (_canceled) {
      callback();
      return;
    }
    _callbacks.add(callback);
  }

  /// 未キャンセルなら何もしない。キャンセル済みなら [SearchCanceledException]。
  /// 各 HTTP 送信の直前に置き、close 後のクライアントを叩かせない。
  void throwIfCanceled() {
    if (_canceled) throw const SearchCanceledException();
  }

  /// 冪等。二度目以降は後始末を再実行しない。
  void cancel() {
    if (_canceled) return;
    _canceled = true;
    final callbacks = List<void Function()>.of(_callbacks);
    _callbacks.clear();
    for (final callback in callbacks) {
      callback();
    }
  }
}
