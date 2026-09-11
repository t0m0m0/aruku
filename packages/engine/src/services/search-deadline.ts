// 移植元: lib/core/services/search_deadline.dart

import { notImplemented } from '../not-implemented';
import type { Duration } from '../time';

/// 検索1回分の締切（#300）。開始からの経過を持ち、残予算と期限切れを答える。
///
/// [CancellationToken] と別の型にしているのは、両者が正反対の終わり方を指すため。
/// キャンセルは「結果は要らない」＝ in-flight ごと落として例外で抜ける。締切は
/// 「これ以上待てないが結果は要る」＝**既に得た候補で確定させる縮退の合図**で、
/// 超過しても検索は失敗しない。
export class SearchDeadline {
  /// [total] を使い切るまでを予算とする。[elapsed] 未指定なら実時間で進む。
  constructor(total: Duration, options: { elapsed?: () => Duration } = {}) {
    this.total = total;
    this.elapsed = options.elapsed ?? realtimeElapsed();
  }

  /// 締切を設けない null object。締切を任意にする呼び出し側が `SearchDeadline | null`
  /// を持ち回って null 分岐を撒かずに済むようにする。
  static none(): SearchDeadline {
    const deadline = new SearchDeadline(0);
    deadline.total = null;
    deadline.elapsed = null;
    return deadline;
  }

  private total: Duration | null;
  private elapsed: (() => Duration) | null;

  /// 残予算。使い切ったら 0（負にはしない）。[SearchDeadline.none] は null。
  get remaining(): Duration | null {
    return notImplemented('SearchDeadline.remaining');
  }

  /// 残予算を使い切ったか。[SearchDeadline.none] は常に false。
  get isExpired(): boolean {
    return notImplemented('SearchDeadline.isExpired');
  }
}

/// 移植元の `Stopwatch` に対応する。`Date.now()` を使わないのは、それが壁時計で
/// NTP 補正や手動の時刻変更で前後に飛ぶため——120 秒の締切が永久に切れない／即座に
/// 切れるという、再現できない形で壊れる。`performance.now()` は単調で `Stopwatch` と
/// 同じ性質を持つ。
function realtimeElapsed(): () => Duration {
  const start = performance.now();
  return () => performance.now() - start;
}
