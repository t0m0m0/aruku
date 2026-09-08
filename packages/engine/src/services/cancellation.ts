// 移植元: lib/core/services/cancellation.dart

import { notImplemented } from '../not-implemented';

/// 検索1回分のキャンセル境界（#259）。ユーザーがローディングを離脱した時点で、
/// 進行中の HTTP を実際に切るために使う。
///
/// [RouteException] と別の型にしているのは、[TransitRouteService] の縮退パス
/// （失敗レッグを直線推定へ落とす `catch (RouteException)`）にキャンセルが吸収されると、
/// キャンセル後も残りのファンアウトが走り続けてしまうため。
export class SearchCanceledException extends Error {
  constructor() {
    super('SearchCanceledException');
    this.name = 'SearchCanceledException';
  }
}

/// 一度だけ倒せるフラグと、倒れた瞬間に走らせる後始末の束。
///
/// 中断は「検索単位で作った client を [onCancel] で閉じる」形で実現する
/// （[HttpClient] に要求単位の abort を置いていない理由は http-client.ts 参照）。
export class CancellationToken {
  get isCanceled(): boolean {
    return notImplemented('CancellationToken.isCanceled');
  }

  /// キャンセル時に呼ぶ後始末を登録する。既にキャンセル済みなら即座に実行する。
  onCancel(callback: () => void): void {
    notImplemented(`CancellationToken.onCancel(${typeof callback})`);
  }

  /// 未キャンセルなら何もしない。キャンセル済みなら [SearchCanceledException]。
  throwIfCanceled(): void {
    notImplemented('CancellationToken.throwIfCanceled');
  }

  /// 冪等。二度目以降は後始末を再実行しない。
  cancel(): void {
    notImplemented('CancellationToken.cancel');
  }
}
