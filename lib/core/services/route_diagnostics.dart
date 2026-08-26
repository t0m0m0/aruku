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

  /// この探索が実際に打ち上げた probe 本数（上流失敗ぶんも含む）。
  ///
  /// [rounds] では代用できない——1ラウンドは `_boardSearchFanout` 本**まで**で、残り
  /// index が少ないラウンドはそれより細る。**上流へ払った往復本数**を知りたいときの単位で、
  /// 投機起動（#341）が空振りしたときの対価はこれで測る（壁時計は enrich と重なって
  /// ほぼ 0 になるので、捨てた探索の費用を表さない）。
  int probes = 0;

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
  /// - **引き直しの失敗**: その点は**未評価**として境界の更新から外れる（#333）。予算外との
  ///   誤認は起きないが、探索はその点を飛ばすぶん浅くなり、境界が**手前**に留まり得る。
  /// - **徒歩実測の失敗**: `_tryWalk` が落ちると直線推定へ縮退する。直線は実街路に対し
  ///   大きく楽観に倒れる（#137 実機で -36分・25%）ので、境界が**奥**へ動き得る。
  ///
  /// [truncated] と原因が違うので別に持つ——締切は我々の予算、こちらは上流の安定性で、
  /// 次に打つ手が変わる。締切由来のタイムアウトでは両方立ち得る。
  bool probeFailed = false;

  /// **ラウンドを1つ終えるごとの「評価済みで予算内だった最大徒歩（見積り・分）」**。
  ///
  /// 「ラウンド N で打ち切ったら徒歩が短くなるのか」を直接読むための系列。単調非減少なので、
  /// 頭打ちになった位置がそのまま**打ち切ってよいラウンド**を意味する（`23,72,72` なら
  /// 3ラウンド目は徒歩を1分も増やしていない）。
  ///
  /// [best]（境界 index）では代用できない——index が奥へ進んでも徒歩が伸びるとは限らず、
  /// 実測でも `best` が 12→21 と動いて最終徒歩は 78分のまま一致した例がある。**判断したいのは
  /// 目的関数そのもの（徒歩）であって、探索の進み具合ではない。**
  ///
  /// 見積り徒歩で記録する。確定値は enrich 後にしか出ないが、それを待つとラウンド境界で
  /// 記録できない。系列の**形（どこで頭打ちか）**が目的なので、一貫して見積りで採る。
  final List<int> walkByRound = [];

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

/// enrich フェーズの臨界パスを「パスの本数」と「1候補の直列段数」に分けて計上する台帳。
///
/// enrich は board-search と同じ形をしている——**パスは直列・候補は並列**：
/// 1パス＝`Future.wait(候補ごと)`、1候補＝`_enrichWalkGeometry`（徒歩は並列）→
/// `_resolveBoardingTimes`（transit 区間ごとに guidance を**直列**）。よって
/// [criticalPathMs] = Σ_passes max_candidate(1候補の連鎖) が壁時計の本体になる。
///
/// **本数と段数を分けるのが目的。** §3.7 の Option A（#318）はパスの**本数**を 2→1 へ
/// 潰す最適化だが、1パスの中に残る**段数**（時刻なし transit 区間の数だけ積む guidance）
/// には効かない。両者を別々に出さないと「Option A が効いているのに enrich が重い」を
/// 説明できず、次に削るべき対象を取り違える。
///
/// **計上するのは [TransitRouteService] の単一測定口（`_measureCandidate`）を通った
/// 候補だけ。** キャッシュヒットは壁時計を払っていないので数えない。best-effort 縮退
/// （`_bestEffortResolved`）は測定口を通さず `_resolveBoardingTimes` を直に呼ぶため
/// 含まれない——`enrichMs` との差はそこにも出る。
class EnrichLatencyLedger {
  int _closedCritical = 0;
  int _passCritical = 0;
  int _passes = 0;
  bool _passHasCandidate = false;

  /// 実測した候補数（キャッシュヒットを除く）＝上流ファンアウトの幅。
  int candidates = 0;

  /// 1候補が `_resolveBoardingTimes` で直列に積んだ guidance の最大段数。
  int resolveDepth = 0;

  /// 候補1件の実測を現在のパスへ記録する。[chainMs] は徒歩 enrich と引き直しを合わせた
  /// その候補の連鎖の壁時計、[resolveSteps] はそのうち直列に積んだ guidance の本数。
  void record({required int chainMs, required int resolveSteps}) {
    candidates++;
    _passHasCandidate = true;
    if (chainMs > _passCritical) _passCritical = chainMs;
    if (resolveSteps > resolveDepth) resolveDepth = resolveSteps;
  }

  /// 現在のパスを締めて累積へ畳む。候補が1件も無いパスは本数に数えない——先行実測が
  /// 発火しない検索では空の締めが先に来るため。
  void endPass() {
    if (!_passHasCandidate) return;
    _closedCritical += _passCritical;
    _passes++;
    _passCritical = 0;
    _passHasCandidate = false;
  }

  /// 直列に積んだパスの壁時計の合計（Σ_passes 最遅候補）。
  int get criticalPathMs =>
      _closedCritical + (_passHasCandidate ? _passCritical : 0);

  /// 直列に走ったパスの本数。
  int get passes => _passes + (_passHasCandidate ? 1 : 0);

  // 進行中パスをゲッタ側で足すのは [ProbeLatencyLedger] と同じ理由——勝者が見つかった
  // 時点で tier ループを return で抜けるため、末尾の締めを呼び出し側の義務にすると
  // 「1パスで決まった」最も一般的なケースがまるごと 0 になる。
}

/// best-effort 縮退（`_bestEffortResolved`）の費用を計上する台帳。
///
/// **[EnrichLatencyLedger] と別に持つ理由が実測で判明している。** `enrichCriticalMs` を
/// 入れて初めて測った1本は `enrichMs=58.2s` に対し臨界パスが 4.9s（8.4%）しかなく、残りは
/// この経路だった。`_bestEffortResolved` は測定口（`_measureCandidate`）を通らず
/// `_resolveBoardingTimes` を直に呼ぶため、[EnrichLatencyLedger] からは**構造的に見えない**。
///
/// コスト中心が2つあり、分けないと打ち手を選べない：
/// - **プール全体の並列解決**（幅）: `_maxMeasureShortlist` の上限が効かず候補プール全部を
///   解決する。[candidates] が幅、[resolveDepth] が1候補の直列段数。
/// - **`while` の再試行ループ**（段数）: 乗り遅れ候補を1件ずつ外して**直列に** enrich し直す。
///   [retries] がその段数で、1段ごとに徒歩プロキシ1往復ぶんの壁時計が乗る。
///
/// 縮退は1検索で複数回通り得る（縮退 → バス last-resort → `_selectAndEnrich` の再帰 →
/// 再び縮退）。それらは**直列**に走るので [totalMs]・[candidates]・[retries] は和、
/// [resolveDepth] だけ最大を採る（「1候補が積んだ段数」という意味を保つため）。
class BestEffortLedger {
  /// `_bestEffortResolved` に入った回数。
  int entries = 0;

  /// 実時刻解決したのべ候補数＝短リスト上限に縛られないファンアウト幅。
  int candidates = 0;

  /// プール解決で1候補が直列に積んだ引き直しの最大段数。
  int resolveDepth = 0;

  /// 再試行ループが回った回数（＝直列に積んだ徒歩 enrich の追加段数）。
  int retries = 0;

  /// 縮退に費やした実時間の合計。`enrichMs` からこれを引いた残りが、なお計上外の区間。
  int totalMs = 0;

  void enter() => entries++;

  void recordPool({required int candidates, required int resolveDepth}) {
    this.candidates += candidates;
    if (resolveDepth > this.resolveDepth) this.resolveDepth = resolveDepth;
  }

  void recordRetry() => retries++;

  void addMs(int ms) => totalMs += ms;
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

  /// 初回 `/guidance/plan` の **departure 波**（必須の1本）に掛かった実時間（ミリ秒）。
  /// 並列に走る到着アンカー第2波（#376）は含めない——あちらは fail-soft の改善で、
  /// 待たされる床を決めるのは必須波の方だから。
  int guidanceMs = 0;

  /// ハイブリッド候補生成（コリドー実測マトリクス＋候補構築）区間の実時間。
  int hybridMs = 0;

  /// 選定＋enrich（実測徒歩・実発車時刻の確定検証）区間の実時間。非崩壊時は見積り
  /// フロント（勝者＋棄却時のフォールバック候補）の1並列パス先行実測もここに含む（#315）。
  ///
  /// **崩壊時の再選定ぶんも含む。** 台帳（[enrichCriticalMs] / [bestEffortMs]）が再選定の
  /// enrich も積む以上、時計だけ board-search 突入時点で止めると計上外の残り
  /// （`enrichMs − enrichCriticalMs − bestEffortMs − busLastResortMs`）が負に化ける。
  /// その区間は [boardSearchMs] にも含まれる——フェーズの分割より「台帳と時計が同じ区間を
  /// 覆う」ことを優先した意図的な重なりなので、フェーズ所要を足し上げるときは注意する。
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

  /// 報告する探索の、ラウンドごとの「予算内の最大徒歩（見積り・分）」の推移
  /// （[BoardSearchStats.walkByRound]）。**頭打ちの位置＝打ち切ってよいラウンド。**
  List<int> boardSearchWalkByRound = const [];

  /// **確定候補が board-search の何ラウンド目の probe 由来か。**
  ///
  /// [boardSearchWalkByRound] だけでは打ち切りを判断できない——あれは「天井（予算内の最大
  /// 見積り徒歩）が上がったか」しか答えず、天井を作った候補が実測を生き延びるとは限らない。
  /// 実測でも `67,67` と天井が据え置きなのに最終徒歩が 61分（＜67）になった例がある。
  /// **「ラウンド N を切ったら答えが変わるか」に答えられるのはこちら。**
  ///
  /// 値の意味を3つに分ける（0 が「未起動」と「由来でない」を兼ねると読めなくなるため）:
  /// - **-1** — board-search が起動しなかった
  /// - **0** — 起動したが確定候補は board-search 由来でない、**または同一性が切れて特定不能**
  /// - **N ≥ 1** — そのラウンドの probe が作った候補が勝った
  ///
  /// 「特定不能」が混ざるのは best-effort 縮退を経た場合。`_resolveBoardingTimes` が実時刻を
  /// 当てた**コピー**を作るため参照が切れる（通常の tier 実測は `chosen` にプール要素をその
  /// まま返すので保たれる）。0 を「board-search は無駄だった」と読んではいけない。
  int boardSearchWinnerRound = -1;

  /// 確定経路の徒歩（分）。未確定は -1。
  ///
  /// 定性ログ（`[route] === FINAL`）は debug 限定なので、**フィールド計測を行う profile
  /// ビルドでは最終徒歩がどこにも出ない**。[boardSearchWalkByRound] と突き合わせて
  /// 「探索を打ち切ったら答えが劣化するか」を集計するには、同じ1行に無いと使えない。
  int finalWalkMinutes = -1;

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

  /// 電車系 board-search を `preCollapse` の見込みで enrich と**並行に**起動したか（#341）。
  /// 発火率の分子。効くのは縮退する検索だけなので、中央値ではなくこの率と
  /// [boardSearchSpeculationWasted] の対で費用対効果を読む。
  bool boardSearchSpeculated = false;

  /// 投機起動したが `collapse` が偽で結果を捨てたか（＝無駄撃ち）。
  ///
  /// [boardSearchActivated] とは別に持つ。あちらは「board-search の候補を実際に使ったか」で、
  /// 空振りの投機はプールへ1件も足していない——同じ印にすると、起動率の分母が投機ぶんだけ
  /// 膨らんで board-search 本体の発火率が読めなくなる。
  bool boardSearchSpeculationWasted = false;

  /// 空振りした投機が上流へ打ち上げた probe 本数（[BoardSearchStats.probes]）。
  ///
  /// **対価の単位は ms ではない。** 投機は enrich と並行に走るので、捨てた探索が
  /// ユーザーへ払わせた壁時計はほぼ 0。実際に消費するのは第三者 API の未知のレート枠
  /// （§2.1・§3.6）なので、往復本数で数える。
  int boardSearchSpeculationProbes = 0;

  /// 空振りした投機の対価を計上する（#341）。発火（[boardSearchSpeculated]）と対で読む。
  void recordSpeculationWaste(BoardSearchStats stats) {
    boardSearchSpeculationWasted = true;
    boardSearchSpeculationProbes = stats.probes;
  }

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
    boardSearchWalkByRound = List.unmodifiable(dominant.walkByRound);
    boardSearchProbeSerialMs = dominant.probeLatency.serialMs;
    boardSearchProbeParallelMs = dominant.probeLatency.parallelMs;
  }

  /// enrich の臨界パス（Σ_passes 最遅候補）。[enrichMs] との差が、単一測定口を通らない
  /// 区間（best-effort 縮退の実時刻解決・選定の純粋計算）と計装の取りこぼしを表す。
  int enrichCriticalMs = 0;

  /// enrich が直列に走らせたパスの本数。**§3.7 Option A が潰そうとしている量。**
  int enrichPasses = 0;

  /// 1候補が `_resolveBoardingTimes` で直列に積んだ guidance の最大段数。
  /// **Option A が潰せない量**——1パスに畳んでも、時刻なし transit 区間の数だけ
  /// 上流1本ぶんの壁時計が残る。[enrichPasses] と分けて持つのは、両者を足した1つの数では
  /// 「本数を減らすべきか段数を減らすべきか」を判断できないため。
  int enrichResolveDepth = 0;

  /// 実測した候補数（キャッシュヒットを除く）＝上流ファンアウトの幅。Option A は
  /// [enrichPasses] を減らす代わりにこれを増やすので、恩恵と対価をこの対で読む（#318）。
  int enrichCandidates = 0;

  /// 並列に走った enrich 台帳を1検索ぶんの指標へ畳む。board-search（[recordBoardSearches]）と
  /// 違い**台帳は検索に1つ**なので、支配探索を選ぶ必要がない。
  void recordEnrich(EnrichLatencyLedger ledger) {
    enrichCriticalMs = ledger.criticalPathMs;
    enrichPasses = ledger.passes;
    enrichResolveDepth = ledger.resolveDepth;
    enrichCandidates = ledger.candidates;
  }

  /// best-effort 縮退に費やした実時間。**`enrichMs` の会計を閉じるための項**——
  /// `enrichMs − enrichCriticalMs − bestEffortMs − busLastResortMs` が、なお計上外の区間。
  int bestEffortMs = 0;

  /// 縮退へ入った回数（縮退 → バス last-resort → 再帰で複数回通り得る）。
  int bestEffortEntries = 0;

  /// 縮退が実時刻解決したのべ候補数。**`_maxMeasureShortlist`(13) の上限が効かない幅**で、
  /// 上流ファンアウトの実際の上限はここで決まる。
  int bestEffortCandidates = 0;

  /// 縮退のプール解決で1候補が直列に積んだ引き直しの最大段数。
  int bestEffortResolveDepth = 0;

  /// 縮退の再試行ループが回った回数＝直列に積んだ徒歩 enrich の追加段数。
  int bestEffortRetries = 0;

  /// バス last-resort 再照会（`_fetchBusOptions`）で**なお直列に待った**時間。照会は
  /// best-effort 縮退と並行して投機発行するので、これは発行〜完了の全体ではなく
  /// **投機で覆えなかった残りの待ち**。並行に隠れたぶんは縮退側（[bestEffortMs]）の
  /// 壁時計に含まれる。0 に近いほど投機が効いている＝この最適化の効き目そのもの。
  int busLastResortMs = 0;

  /// best-effort 台帳を1検索ぶんの指標へ畳む。
  void recordBestEffort(BestEffortLedger ledger) {
    bestEffortMs = ledger.totalMs;
    bestEffortEntries = ledger.entries;
    bestEffortCandidates = ledger.candidates;
    bestEffortResolveDepth = ledger.resolveDepth;
    bestEffortRetries = ledger.retries;
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

  /// 到着アンカー第2波（#376）が解析可能な非空応答を返したか。**失敗（HTTP/TIMEOUT/
  /// パース不能）と「応答は返ったが option が0本」を区別しない**——どちらも合流できる
  /// 素材が無かったという同じ結果で、判定（毎検索 +1 本の対価に見合うか）に必要なのは
  /// 「素材が入ったか」だけだから。
  bool arrivalWaveOk = false;

  /// 第2波から候補プールへ**純増**した option 数（構造フィンガープリント dedup の後）。
  /// [arrivalWaveOk] が真でもここが 0 なら、その経路では departure 波と同じ便しか
  /// 返らなかった＝第2波は何も足していない。
  int arrivalWaveOptions = 0;

  /// `basesForHybrid` が選んだ base に第2波由来の option が含まれたか。**コリドーが
  /// 掘られたか**の分子で、[arrivalWaveWon] とは別に持つ——base に入っても勝てるとは
  /// 限らないし、勝たなくても「別系統のコリドーを候補にできた」ことは効果の前提になる。
  bool arrivalWaveBaseUsed = false;

  /// 確定候補が第2波由来か（標準乗換ならその option 自身、ハイブリッド・board-search 候補
  /// なら土台にした base）。
  ///
  /// **0 は「由来でない」と「同一性が切れて特定不能」を兼ねる**（[boardSearchWinnerRound]
  /// の 0 と同じ事情。best-effort 縮退は実時刻を当てたコピーを作るため参照が切れる）。
  bool arrivalWaveWon = false;

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
      'arrivalWaveOk=${arrivalWaveOk ? 1 : 0} '
      'arrivalWaveOptions=$arrivalWaveOptions '
      'arrivalWaveBaseUsed=${arrivalWaveBaseUsed ? 1 : 0} '
      'arrivalWaveWon=${arrivalWaveWon ? 1 : 0} '
      'guidanceMs=$guidanceMs hybridMs=$hybridMs enrichMs=$enrichMs '
      'boardSearchMs=$boardSearchMs '
      'boardSearchRounds=$boardSearchRounds '
      'boardSearchScanCount=$boardSearchScanCount '
      'boardSearchBest=$boardSearchBest '
      'boardSearchTruncated=${boardSearchTruncated ? 1 : 0} '
      'boardSearchProbeFailed=${boardSearchProbeFailed ? 1 : 0} '
      'boardSearchProbeSerialMs=$boardSearchProbeSerialMs '
      'boardSearchProbeParallelMs=$boardSearchProbeParallelMs '
      'boardSearchSpeculated=${boardSearchSpeculated ? 1 : 0} '
      'boardSearchSpeculationWasted=${boardSearchSpeculationWasted ? 1 : 0} '
      'boardSearchSpeculationProbes=$boardSearchSpeculationProbes '
      'enrichCriticalMs=$enrichCriticalMs enrichPasses=$enrichPasses '
      'enrichResolveDepth=$enrichResolveDepth '
      'enrichCandidates=$enrichCandidates '
      'bestEffortMs=$bestEffortMs bestEffortEntries=$bestEffortEntries '
      'bestEffortCandidates=$bestEffortCandidates '
      'bestEffortResolveDepth=$bestEffortResolveDepth '
      'bestEffortRetries=$bestEffortRetries '
      'busLastResortMs=$busLastResortMs '
      'boardSearchWalkByRound='
      '${boardSearchWalkByRound.isEmpty ? '-' : boardSearchWalkByRound.join(',')} '
      'boardSearchWinnerRound=$boardSearchWinnerRound '
      'finalWalkMinutes=$finalWalkMinutes '
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
