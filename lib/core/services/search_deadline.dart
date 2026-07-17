/// 検索1回分の締切（#300）。開始からの経過を持ち、残予算と期限切れを答える。
///
/// [CancellationToken] と別の型にしているのは、両者が正反対の終わり方を指すため。
/// キャンセルは「結果は要らない」＝ in-flight ごと落として例外で抜ける。締切は
/// 「これ以上待てないが結果は要る」＝ **既に得た候補で確定させる縮退の合図**で、
/// 超過しても検索は失敗しない。締切で `close()` してしまうと必須の初期照会まで
/// 道連れになり、#300 で直したはずの「通信に失敗しました」へ戻る。
///
/// 上流 Transit API は無料・無認証・無 SLA の第三者 API で、`/guidance/plan` の
/// 応答は 9〜11 秒が正常・裾は 30 秒超（2026-07-17 実測。
/// docs/notes/transit-api-migration.md §1.1-5・§8）。1本あたりの上限だけでは
/// 検索全体の待ち時間を縛れない——引き直しは TIMEOUT を握って縮退するが、縮退
/// する前に上限いっぱい待つため、直列ラウンド数との積で効く。1本の上限（ハング
/// 検出）と検索全体の締切（体感保証）を別レイヤーに分けるのはこのため。
class SearchDeadline {
  /// [total] を使い切るまでを予算とする。[elapsed] 未指定なら実時間で進む。
  SearchDeadline(Duration total, {Duration Function()? elapsed})
    : _total = total,
      _elapsed = elapsed ?? _realtimeElapsed();

  /// 締切を設けない null object。締切を任意にする呼び出し側（テスト・既存経路）が
  /// `SearchDeadline?` を持ち回って null 分岐を撒かずに済むようにする。
  const SearchDeadline.none() : _total = null, _elapsed = null;

  final Duration? _total;
  final Duration Function()? _elapsed;

  static Duration Function() _realtimeElapsed() {
    final stopwatch = Stopwatch()..start();
    return () => stopwatch.elapsed;
  }

  /// 残予算。使い切ったら [Duration.zero]（負にはしない）。[SearchDeadline.none] は null。
  Duration? get remaining {
    final total = _total;
    if (total == null) return null;
    final left = total - _elapsed!();
    return left.isNegative ? Duration.zero : left;
  }

  /// 残予算を使い切ったか。[SearchDeadline.none] は常に false。
  bool get isExpired => remaining == Duration.zero;
}
