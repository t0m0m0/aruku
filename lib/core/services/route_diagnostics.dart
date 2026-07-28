import 'package:flutter/foundation.dart';

import '../models/route_plan.dart';
import 'hybrid_route_selector.dart';
import 'route_plan_builder.dart';

/// 乗車駅探索**1本**分の計上。1検索に2本立つことがある——電車系（base）とバス系
/// （busBase）は基準コリドーが独立で、並行して走る（#304）。1つの [RouteSearchMetrics]
/// を両方から直接触ると、[scanCount] と [best] が別々の探索の値で上書きされて実在しない
/// 対になり、[rounds] は並行して走ったものの和になる。探索ごとにこれを持ち、
/// [RouteSearchMetrics.recordBoardSearches] で明示的に畳む。
///
/// 2本は**同時に始まらない**：バス系は `_buildCorridorHybrids`（matrix/walk のアクセス
/// 徒歩実測）を待ってから探索へ入る。だから畳んだ [RouteSearchMetrics.boardSearchRounds]
/// は「最も深い1本の段数」であって、フェーズの経過段数ではない。
class BoardSearchStats {
  /// この探索が回したラウンド数。
  int rounds = 0;

  /// この探索が走査した index 数。
  int scanCount = 0;

  /// この探索が**評価済みの中で予算内だった最遠 index**（皆無なら -1）。
  ///
  /// 二分探索の戻り値そのものではない。探索は最初の予算外 probe で結果の走査を打ち切る
  /// ので、同一ラウンドでそれより奥に評価済みの予算内点があっても戻り値には現れない。
  /// 呼び出し側は非単調を前提に評価済みの予算内候補を全部プールへ足すため（#137）、
  /// 「どこまで予算内だったか」は評価済み集合から採るのが実態と合う。
  int best = -1;

  /// 締切で**新しいラウンドを起こさずに打ち切った**か（#300）。打ち切ると [best] は
  /// 本来より手前になり得るので、境界位置の分布へ確定値として混ぜてはいけない。
  bool truncated = false;

  /// **入力が劣化したまま評価された probe があったか**（上流の 429・5xx・タイムアウト）。
  /// 2種類あり、どちらも境界をその地点の実力から引き剥がす:
  ///
  /// - **引き直しの失敗**: `_fetchTransitFrom` の null 縮退は「予算外」と解釈され区間を
  ///   捨てるので、境界が**手前**へ動き得る（#333 が扱う失敗モード）。
  /// - **徒歩実測の失敗**: `_tryWalk` が落ちると直線推定へ縮退する。直線は実街路に対し
  ///   大きく楽観に倒れる（#137 実機で -36分・25%）ので、境界が**奥**へ動き得る。
  ///
  /// [truncated] と原因が違うので別に持つ——締切は我々の予算、こちらは上流の安定性で、
  /// 次に打つ手が変わる。締切由来のタイムアウトでは両方立ち得る。
  bool probeFailed = false;

  /// この探索がプローブ内で払った直列の壁時計と、その直列を解いた下限
  /// （[ProbeLatencyLedger]）。探索ごとに持つのは [rounds] と同じ理由——2系統は並列に
  /// 走るので、1つの台帳を両方から触るとラウンド境界が混ざって `max` が別探索のプローブ
  /// をまたぐ。
  final ProbeLatencyLedger probeLatency = ProbeLatencyLedger();
}

/// 乗車駅探索のプローブ内で払っている**直列**の壁時計と、それを並列化したときの下限を
/// 同一 run から両方計上する台帳。
///
/// 現状 `buildAt` は「徒歩実測（walk proxy）→ guidance 引き直し」の順に **await** する
/// ——後者の照会時刻 `boardAt` が前者の所要で決まるため。だが t1 は
/// `_boardSearchScanCount` が matrix で全点実測済みで、そちらを `boardAt` に使えば
/// guidance を即発行でき、徒歩実測はジオメトリ用に並行できる。**その改修が何秒縮めるか**を
/// 実装前に知るための計上。
///
/// ラウンドの壁時計は k 並列プローブの `max` なので、
/// - [serialMs]   = Σ_rounds max_i(walk_i + guidance_i)  ＝ 現状
/// - [parallelMs] = Σ_rounds max_i(max(walk_i, guidance_i)) ＝ 直列を解いた下限
///
/// 差が削減可能量の上限になる。**別 run の A/B ではなく同一 run 内の反実仮想**なのが要点：
/// 上流のレイテンシは中央値9〜11秒・裾30秒超（route-optimization.md §2.2-6）で、数試行の
/// ms 比較では「改善したのか上流が空いていたのか」を区別できない（#332 実測では3組とも ms が
/// 改善して見えたが、実際に段数が減っていたのは1組だけだった）。同じプローブの実測から両方を
/// 出せば、上流のばらつきは両者に等しく乗るので差だけを取り出せる。
class ProbeLatencyLedger {
  int _closedSerial = 0;
  int _closedParallel = 0;
  int _roundSerial = 0;
  int _roundParallel = 0;

  /// プローブ1本の内訳を現在のラウンドへ記録する。徒歩がレッグキャッシュにヒットした
  /// プローブは [walkMs] が 0 近傍になり、そのぶん自動的に削減可能量から外れる。
  ///
  /// [walkMs] には `_WalkLegCache` の in-flight に相乗りして他プローブの取得を待った時間も
  /// 含める。待たされた実壁時計こそがユーザーの体感で、除くと削減可能量を過小に見積もる。
  void record({required int walkMs, required int guidanceMs}) {
    final serial = walkMs + guidanceMs;
    final parallel = walkMs > guidanceMs ? walkMs : guidanceMs;
    if (serial > _roundSerial) _roundSerial = serial;
    if (parallel > _roundParallel) _roundParallel = parallel;
  }

  /// 現在のラウンドを締めて累積へ畳む。プローブが無いラウンドは 0 の加算＝実質 no-op
  /// （`onRound` はラウンド**開始時**に呼ばれるので、1本目の締めは必ず空になる）。
  void endRound() {
    _closedSerial += _roundSerial;
    _closedParallel += _roundParallel;
    _roundSerial = 0;
    _roundParallel = 0;
  }

  /// 現状の壁時計（Σ_rounds 最遅プローブの walk+guidance）。
  int get serialMs => _closedSerial + _roundSerial;

  /// プローブ内の直列を解いたときの壁時計の下限（Σ_rounds 最遅プローブの max(walk, guidance)）。
  int get parallelMs => _closedParallel + _roundParallel;

  // 進行中ラウンドをゲッタ側で足すのは、末尾フラッシュを呼び出し側の義務にしないため。
  // 探索は締切超過（shouldContinue）で while を break で抜けるので、「最後に endRound を
  // 呼ぶ」規約は最も測りたいケース（打ち切られるほど重かった探索）で静かに破れる。
}

/// 1検索分の定量指標（#309）。collapse 発火・board-search 起動・上流 HTTP 往復本数・
/// フェーズ別所要時間を1オブジェクトに集約し、[toLogLine] で機械集計可能な1行に整形する。
///
/// 定性ログ（[RouteDiagnostics.log]）が「なぜこの候補が勝ったか」を人間向けに追うのに対し、
/// これは「発火率・本数・所要」を実機ログから grep で集計するための定量出力（#309 の狙い）。
/// 可変（アキュムレータ）なのは、選定が複数フェーズ・並列 IO にまたがり値が後から確定する
/// ため。1インスタンス＝1検索の寿命で、[TransitRouteService.plan] が生成・充填・出力する。
class RouteSearchMetrics {
  /// 崩壊判定（`_isCollapse`）が true になったか（board-search を試みる契機）。
  bool collapseFired = false;

  /// board-search フォールバックが実際に候補を引きに走ったか。
  bool boardSearchActivated = false;

  /// 非崩壊ルートの先行実測で「見積りフロントだけ」でなく予算内短リスト全体を1パスで温めたか
  /// （Option A・#318）。予算内ハイブリッドが多い reject 多発ルートで発火し、reject 後の2パス目を
  /// 先行実測へ畳む。恩恵（enrichMs 短縮）とコスト（guidance ファンアウト増）が発火率で決まるので
  /// 本番ログから機械集計できるよう計上する。
  bool singlePassMeasure = false;

  /// 初回 `/guidance/plan`（必須の1本）に掛かった実時間（ミリ秒）。
  int guidanceMs = 0;

  /// ハイブリッド候補生成（コリドー実測マトリクス＋候補構築）区間の実時間。
  int hybridMs = 0;

  /// 初回の選定＋enrich（実測徒歩・実発車時刻の確定検証）区間の実時間。非崩壊時は見積り
  /// フロント（勝者＋棄却時のフォールバック候補）の1並列パス先行実測もここに含む（#315）。
  /// 崩壊時の再選定は [boardSearchMs] に含める（二重計上しない）。
  int enrichMs = 0;

  /// board-search フォールバック区間の実時間（起動しなければ 0）。崩壊時の再選定
  /// （board-search 候補を足した再 enrich）もこの区間に含む。
  int boardSearchMs = 0;

  /// **最も深い1本の**乗車駅探索が回したラウンド数（＝その探索が直列に積んだ guidance の段数）。
  ///
  /// **フェーズ全体の経過段数ではない。** 2系統が走るとき、バス系は
  /// `_buildCorridorHybrids`（matrix/walk のアクセス徒歩実測）を待ってから探索を始めるので
  /// 開始がずれる——電車系と完全に重なる保証はなく、経過時間の直列深さはこの値を超え得る。
  /// 壁時計が要るときは [boardSearchMs] を見ること。ここが答えるのは「1本の探索が何段
  /// 積んだか」で、探索アルゴリズムの比較（fanout・probe 配置・打ち切り）に要るのはこちら。
  /// 他の board-search 系フィールドと同じく**支配探索1本**を記述する。
  ///
  /// [boardSearchMs] と別に持つのは、**ms では探索最適化の効き目を判定できない**ため。
  /// ms は上流のレイテンシばらつき（中央値9〜11秒・裾30秒超）を丸ごと含むので、数回の
  /// 試行では「ラウンドが減った」のか「上流が空いていた」のか区別がつかない。#332 の
  /// 実機 A/B では3組とも ms が改善して見えたが、ラウンドが減っていたのは1組だけで、
  /// 残り2組は上流本数まで完全一致＝差はジッタだった。
  int boardSearchRounds = 0;

  /// 乗車駅探索が実際に走査した index 数（`walkFeasiblePrefixCount` で刈った後）。
  /// 境界位置を経路をまたいで比べるときの分母。コリドー点数を分母にすると、#317 の
  /// プレ実測が刈った量だけ比が歪む（実測で 51〜81% 刈れることがある）。
  int boardSearchScanCount = 0;

  /// 乗車駅探索で**評価済みのうち予算内だった最遠 index**（[BoardSearchStats.best] 参照。
  /// 二分探索の戻り値ではない）。**未探索・予算内皆無は -1**（0 は「index 0 が境界だった」
  /// と紛れるため番兵に使えない）。
  int boardSearchBest = -1;

  /// [boardSearchBest] を出した探索が締切で打ち切られたか（#300）。打ち切られた境界は
  /// 本来より手前になり得るため、集計側は境界位置の分布から除く。所要・段数の分布には
  /// 残す（打ち切られるほど重かった探索こそ見たいので）。
  ///
  /// **報告する [boardSearchBest] と同じ探索を指す**（並列に走った別の探索の打ち切りは
  /// 引き継がない）。この印は「この境界が信用できるか」を意味するので、採用した境界が
  /// 正常に確定しているなら、短い方が打ち切られたことを理由に有効なサンプルを捨てては
  /// いけない。
  bool boardSearchTruncated = false;

  /// [boardSearchBest] を出した探索に、入力が劣化したまま評価された probe があったか
  /// （[BoardSearchStats.probeFailed]。引き直しの失敗＝境界が手前へ、徒歩実測の失敗＝
  /// 直線推定への縮退で境界が奥へ動き得る）。境界がその地点の実力ではなく上流の不調で
  /// 決まり得るため、集計側は境界位置の分布から除く。
  bool boardSearchProbeFailed = false;

  /// 報告する探索がプローブ内で払った直列の壁時計（[ProbeLatencyLedger.serialMs]）。
  int boardSearchProbeSerialMs = 0;

  /// 同じ探索で、プローブ内の「徒歩実測 → guidance 引き直し」の直列を解いたときの壁時計の
  /// 下限（[ProbeLatencyLedger.parallelMs]）。
  ///
  /// **[boardSearchProbeSerialMs] との差が、その改修で縮む上限。** 同一 run の同じプローブから
  /// 両方を出しているので、上流のレイテンシばらつきは両者へ等しく乗り、差だけを取り出せる
  /// （別 run の A/B では区別できない・#332）。差が小さければ board-search の律速は
  /// guidance 単体のレイテンシであって直列ではない＝この改修は打つ価値が無いと判定できる。
  int boardSearchProbeParallelMs = 0;

  /// 並列に走った乗車駅探索群（[BoardSearchStats]）を1検索ぶんの指標へ畳む。
  ///
  /// [boardSearchRounds] は**和ではなく最大**——2系統は並列に走る（#304）ので、和にすると
  /// 「1本の探索が何段積んだか」という意味が壊れ、アルゴリズムの比較に使えなくなる。
  /// 最大を採るのは、報告する他のフィールドと同じ**支配探索1本**を指すため。
  /// フェーズの経過段数を表すわけではない（[boardSearchRounds] のドキュメント参照）。
  ///
  /// [boardSearchScanCount]・[boardSearchBest]・[boardSearchTruncated]・
  /// [boardSearchProbeFailed]・[boardSearchProbeSerialMs]・[boardSearchProbeParallelMs]
  /// は**同一の探索から採る**（対を崩すと `best/scanCount` が実在しない比になり、truncated が別の探索を
  /// 指すと有効なサンプルを捨てる）。採るのは段数を決めた探索＝報告する
  /// [boardSearchRounds] と整合する1本。同点なら走査範囲の広い方。
  void recordBoardSearches(Iterable<BoardSearchStats> searches) {
    BoardSearchStats? dominant;
    for (final s in searches) {
      if (s.rounds > boardSearchRounds) boardSearchRounds = s.rounds;
      if (dominant == null ||
          s.rounds > dominant.rounds ||
          (s.rounds == dominant.rounds && s.scanCount > dominant.scanCount)) {
        dominant = s;
      }
    }
    if (dominant == null) return;
    boardSearchScanCount = dominant.scanCount;
    boardSearchBest = dominant.best;
    boardSearchTruncated = dominant.truncated;
    boardSearchProbeFailed = dominant.probeFailed;
    // serial/parallel は**必ず対で**同じ台帳から採る。別探索から拾うと差＝削減可能量が
    // 実在しない値になり、打つ価値の判定を誤らせる。
    boardSearchProbeSerialMs = dominant.probeLatency.serialMs;
    boardSearchProbeParallelMs = dominant.probeLatency.parallelMs;
  }

  /// 確定候補の駅名確定（`_finalizeStationNames`）に掛かった実時間。
  int finalizeMs = 0;

  /// `plan` 入口〜確定までの全体実時間。
  int totalMs = 0;

  /// `/guidance/plan` の実 HTTP 往復本数（初回＋引き直し）。
  int guidanceCalls = 0;

  /// [guidanceCalls] のうち同一リクエストの重複発行だった本数（guidance キャッシュで
  /// 消える上限）。enrich 削減の費用対効果を測るための実測（振る舞いは未変更）。
  int guidanceDupCalls = 0;

  /// Google 徒歩ルート（enrich）の実 HTTP 往復本数。
  int walkCalls = 0;

  /// Google 徒歩マトリクスの実 HTTP 往復本数。
  int matrixCalls = 0;

  /// 1検索あたりの上流 HTTP 往復本数の実測（全種別の合計）。
  int get httpRoundTrips => guidanceCalls + walkCalls + matrixCalls;

  /// grep で機械集計できる安定した key=value 1行に整形する。bool は割合を出しやすいよう
  /// 0/1 に落とす（`grep 'collapse=1' | wc -l` で発火数、総数で割れば発火率）。
  String toLogLine() =>
      'collapse=${collapseFired ? 1 : 0} '
      'boardSearch=${boardSearchActivated ? 1 : 0} '
      'singlePass=${singlePassMeasure ? 1 : 0} '
      'http=$httpRoundTrips '
      'guidanceCalls=$guidanceCalls walkCalls=$walkCalls matrixCalls=$matrixCalls '
      'guidanceDupCalls=$guidanceDupCalls '
      'guidanceMs=$guidanceMs hybridMs=$hybridMs enrichMs=$enrichMs '
      'boardSearchMs=$boardSearchMs '
      'boardSearchRounds=$boardSearchRounds '
      'boardSearchScanCount=$boardSearchScanCount '
      'boardSearchBest=$boardSearchBest '
      'boardSearchTruncated=${boardSearchTruncated ? 1 : 0} '
      'boardSearchProbeFailed=${boardSearchProbeFailed ? 1 : 0} '
      'boardSearchProbeSerialMs=$boardSearchProbeSerialMs '
      'boardSearchProbeParallelMs=$boardSearchProbeParallelMs '
      'finalizeMs=$finalizeMs totalMs=$totalMs';
}

/// 経路選定（[TransitRouteService]）の診断ログ整形を担う。本質的なロジックから
/// ログ整形の関心事を切り離し、選定コードの可読性を上げる（#169）。
///
/// `verbose` が偽（リリースビルド）のとき [log] は一切評価しない。ログ本文は遅延
/// ビルダ（`String Function()`）で受け取り、`candLine` 等の高コストな文字列構築・
/// 再計算（`arrivalMinutes`/`firstMissedTransit`/`maxBoardingWait`）をクロージャ本体に
/// 閉じ込めることで、リリースビルドではコストを一切払わない（#164）。
///
/// 整形メソッド（[segSummary]/[candLine]/[boardingStationOf]）は純粋関数なので
/// `verbose` に依らず常に評価でき、単体テストで挙動を固定できる。
class RouteDiagnostics {
  /// [verbose] が真のときだけ [log] が `[route]` プレフィックス付きで出力する。既定は
  /// [kDebugMode]。debugPrint はリリースビルドでも出力されるため、`kDebugMode` から
  /// 導出してリリースビルドでは無効化する（#153）。
  ///
  /// [metricsEnabled] は [logMetrics]（定量指標）を出すかを別に握る。既定は `!kReleaseMode`
  /// ＝ debug に加え **profile でも出す**。定性ログ（[verbose]）を debug 限定にするのは
  /// スパム抑制のためだが、定量指標は実機のフィールド計測（多くは profile ビルド）で集める
  /// のが目的（#309）なので、debug 専用フラグに縛らない。全ユーザーのログを汚さないよう
  /// release だけは抑制する。
  const RouteDiagnostics({
    bool verbose = kDebugMode,
    bool metricsEnabled = !kReleaseMode,
  }) : _verbose = verbose,
       _metricsEnabled = metricsEnabled;

  final bool _verbose;
  final bool _metricsEnabled;

  /// 定量指標を出す設定か。**呼び出し側が計上そのものを組み立てる前に降りるための述語。**
  ///
  /// [logGuidanceKey] は文字列2本を引数に取る（遅延ビルダではない）ので、ゲートの内側で
  /// 捨てられる release でも呼び出し側が整形コストを払ってしまう。#164 と同じ理由——
  /// 出さないビルドでは一切払わない——で、配線側がこの述語を見て**そもそも通知を繋がない**。
  bool get metricsEnabled => _metricsEnabled;

  /// 選定ログ1行を `[route]` プレフィックス付きで出す（[_verbose] が真のときのみ）。
  ///
  /// メッセージは遅延ビルダ（`String Function()`）で受け取る。[_verbose] が偽の
  /// リリースビルドではクロージャを評価せず、高コストな文字列構築を一切行わない（#164）。
  /// 引数を eager 評価する `void log(String)` では、ガードが効く前にコストを払っていた。
  void log(String Function() build) {
    if (_verbose) debugPrint('[route] ${build()}');
  }

  /// 1検索分の定量指標（#309）を `[route-metrics]` プレフィックス付きで1行出す
  /// （[_metricsEnabled] が真のとき＝既定では release 以外）。定性ログ（[log]）と別
  /// プレフィックス・別フラグにして、profile ビルドの実機ログからも発火率・本数を
  /// `grep '\[route-metrics\]'` で切り出して集計できるようにする（debug 限定にすると
  /// フィールド計測で使う profile で一切出ない・#309 レビュー指摘）。
  void logMetrics(RouteSearchMetrics metrics) {
    if (_metricsEnabled) debugPrint('[route-metrics] ${metrics.toLogLine()}');
  }

  /// 発行した `/guidance/plan` 1本の識別子を `[guidance-key]` 付きで出す
  /// （[logMetrics] と同じゲート＝既定では release 以外）。
  ///
  /// `RouteSearchMetrics.guidanceDupCalls` が数えるのは1検索内の重複だけなので、**検索間・
  /// ユーザー間**の重複はこの行を跨いで集計する（`grep '\[guidance-key\]' | sort | uniq -c`）。
  /// [logMetrics] と別プレフィックスにするのは、あちらが1検索1行なのに対しこちらは照会1本ごとに
  /// 出るため——同じプレフィックスに混ぜると片方だけを切り出せない。
  void logGuidanceKey(String raw, String coarse) {
    if (_metricsEnabled) debugPrint('[guidance-key] raw=$raw coarse=$coarse');
  }

  /// 候補の区間構成を `walk12m+蒲12_train33m+walk3m` 形式の短い文字列にする（ログ用）。
  String segSummary(RouteCandidate c) => c.segments
      .map((s) {
        final prefix = switch (s.type) {
          SegmentType.walk => 'walk',
          SegmentType.train => '${s.line ?? 'train'}_train',
          SegmentType.bus => '${s.line ?? 'bus'}_bus',
        };
        return '$prefix${s.minutes}m';
      })
      .join('+');

  /// 候補1件の診断行（ログ用）。徒歩分・実到着・余り・予算内可否・最大乗車待ち・
  /// 乗り遅れの有無・区間構成を1行に詰める。「徒歩最大が崩壊して短い乗車＋大余りが
  /// 残る」過程（#137）を候補単位で追える。
  String candLine(RouteCandidate c, int budgetMin, DateTime departureAt) {
    final arr = arrivalMinutes(c.segments, departureAt);
    final missed = firstMissedTransit(c.segments, departureAt);
    final wait = maxBoardingWait(c.segments, departureAt);
    return 'walk=${c.walkMinutes}m arr=${arr}m slack=${budgetMin - arr}m '
        'within=${arr <= budgetMin} maxWait=${wait}m '
        'missed=${missed != null} [${segSummary(c)}]';
  }

  /// 候補の最初のtransit（電車・バス）区間の乗車駅名（ログ用）。乗車駅探索でコリドー上の
  /// どの点が実際にどの駅から乗ることになるかを見て、間引きで乗れる駅を飛ばしていないかを
  /// 切り分ける（#137 診断）。transit区間が無い・駅名空なら '?'。
  String boardingStationOf(RouteCandidate c) {
    for (final s in c.segments) {
      switch (s.type) {
        case SegmentType.walk:
          continue;
        case SegmentType.train:
        case SegmentType.bus:
          return s.fromName.isEmpty ? '?' : s.fromName;
      }
    }
    return '?';
  }
}
