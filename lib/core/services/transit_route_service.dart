import 'package:flutter/foundation.dart';
import 'package:google_polyline_algorithm/google_polyline_algorithm.dart';
import 'package:http/http.dart' as http;

import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'cancellation.dart';
import 'hybrid_route_selector.dart';
import 'route_diagnostics.dart';
import 'route_plan_builder.dart';
import 'route_service.dart';
import 'transit_api_client.dart';
import 'transit_plan_parser.dart';

/// 選定・enrich 検証の結果一式。[chosen] は enrich 前の選定候補（guidance 見積りのまま）、
/// [enriched] は Google 実測で確定した採用経路。[pool] は勝者確定後の残存プール
/// （enrich 検証で除外済みの候補を除く・代替案 #290 の母集団）、[relaxBudget] は
/// best-effort 縮退で勝者が予算外のまま確定したか（代替案の予算チェックも同じだけ緩める）。
/// 代替案の選出・検証はここでは行わない：崩壊時は選定が2回走り、1回目の結果は捨てられる
/// ため、最終 selection が確定した後に [_validatedAlternatives] を1回だけ掛ける。
typedef _Selection = ({
  RouteCandidate chosen,
  RouteCandidate enriched,
  List<RouteCandidate> pool,
  bool relaxBudget,
});

/// Transit API（`/guidance/plan`）から、予算内で徒歩を最大化するルートを生成する
/// `RouteService`（#137）。NAVITIME 版（[NaviTimeRouteService]）を置換する。
///
/// 経路取得は Transit API を直叩き（認証不要・CORS）、アクセス徒歩の実測だけは
/// Google Routes プロキシ（App Check）を介す。選定（measure-first・乗車駅探索・
/// best-effort 縮退）と純粋関数（[selectBestRoute]/[maxWalkBoardingIndex]/
/// [frontierStations]/[arrivalMinutes]/[buildRoutePlan]）はデータ源非依存なので流用する。
///
/// NAVITIME 版との差（docs/notes/transit-api-migration.md）：
/// - 途中停車駅は `/guidance/plan` の transit polyline（コリドー座標）で代替し、
///   乗車駅探索はコリドーを間引きサンプリングして `plan(X→goal)` を引き直す（§2.5）。
/// - 運賃は取得不可のため廃止（§5）。乗り遅れ再照会（#115）は乗車駅探索へ一本化し
///   廃止（§4）。引き直し便は自己整合なので `firstMissedTransit` が立たない。
class TransitRouteService implements SearchEngine {
  TransitRouteService({
    http.Client? transitClient,
    http.Client? proxyClient,
    String? transitBaseUrl,
    String? proxyBaseUrl,
    DateTime Function()? clock,
    CancellationToken? cancellation,
  }) : _api = TransitApiClient(
         transitClient: transitClient,
         proxyClient: proxyClient,
         transitBaseUrl: transitBaseUrl,
         proxyBaseUrl: proxyBaseUrl,
         cancellation: cancellation,
       ),
       _clock = clock ?? DateTime.now;

  /// Transit API / Google プロキシへの HTTP 通信（#169）。
  final TransitApiClient _api;
  final DateTime Function() _clock;

  /// 選定の診断ログ整形（#169）。`verbose` は既定で [kDebugMode]。
  final RouteDiagnostics _diag = const RouteDiagnostics();

  /// 採用候補を enrich（街路実測）で検証して選び直す試行上限。
  static const int _maxEnrichAttempts = 8;

  /// 代替案（パレート非劣解）の最大提示件数（#290）。
  static const int _maxAlternatives = 3;

  /// 代替案の検証（enrich＋実時刻解決）に掛ける候補数の総上限。検証落ちの補充を
  /// 無制限に回すと、全滅状況（候補が軒並み乗り遅れ・幻便）でフロント全体へ walk/guidance
  /// の IO を掛け尽くしてしまうため、[_maxAlternatives] の3巡分で打ち切る。
  static const int _maxAlternativeValidations = 9;

  /// アクセス徒歩を一括実測するマトリクスの片側の駅数上限（要素数課金を抑える）。
  static const int _maxMatrixSideStations = 10;

  /// 乗車駅探索フォールバックの起動しきい値（崩壊判定・§7）。
  static const int _collapseWalkMarginMin = 10;
  static const double _collapseSlackRatio = 0.4;

  /// 崩壊判定の余り条件（症状2）の絶対値しきい値（分）。予算が大きいと相対比
  /// [_collapseSlackRatio]（予算の40%）が大きくなりすぎ、絶対的には大きな余り（実機の
  /// 下北沢ケースで余り50分・別ケースで29分）でも相対閾値に届かず乗車駅探索が起動しなかった。
  /// 相対・絶対のいずれかを満たせば「予算が大きく余っている」とみなす（#137）。この分数の
  /// 余りがあれば徒歩へ転換する価値があるとみて board-search を試す（外れても余分な往復は
  /// 崩壊時の O(log n) 数回のみ）。
  static const int _collapseSlackMinutes = 20;

  /// 乗車駅探索のk分割並列探索の並列度（#163）。各ラウンドでこの数の候補点を同時評価
  /// する。上げるほどラウンド数が減り速いが、Transit API への同時リクエストと無駄撃ち
  /// （境界決定に使われない評価）が増える。1 にすると従来の直列二分探索と同じ軌道。
  static const int _boardSearchFanout = 3;

  /// 乗車駅探索のコリドー候補点の上限。gtfsShape は線路追従で頂点が密（数百）なため、
  /// 均等間引きでこの数へ絞る（§2.5）。二分探索は実測 walk で駆動するので評価回数は
  /// O(log n) のまま、候補点が密なほど境界の解像度が上がり余りが小さくなる（#137）。
  /// 旧値 25 では隣接候補が約30分徒歩も離れ、境界で徒歩を予算ぎりぎりまで詰められず
  /// 余りが残っていたため引き上げた。
  static const int _maxCorridorStops = 60;

  /// ハイブリッドの土台に据える路線ファミリ base の本数上限（#292）。単一最速1本では
  /// 別路線コリドー由来の徒歩多め候補が原理的に生成されない（限界2）ため、routeName 集合の
  /// 異なる代表を最大この本数だけ土台にする。増やすほど候補が多様化するが、`_maxEnrichAttempts`
  /// の実測試行を食い合い収束前に最短へ縮退する退行（限界3）が起きやすくなるため小さく抑える。
  static const int _maxHybridBases = 3;

  /// 複数 base をマージしたハイブリッド候補の総数上限（#292）。base を増やすと候補が増え、
  /// あるファミリの「見積り予算内・実測予算外」候補が [_maxEnrichAttempts] の試行を食い潰して
  /// 別ファミリの正当な候補を検証前に打ち切り、最短（best-effort＝最早到着）へ縮退させる退行
  /// （限界3）が起きうる。総数をここで抑え、超過時は base 間ラウンドロビンで各ファミリの
  /// 徒歩多め候補を優先的に残す（1ファミリの候補群が他ファミリを締め出さないため・#292 §3）。
  static const int _maxHybridCandidates = 40;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
  }) async {
    if (!_api.hasTransitApi) throw const RouteException('NO_TRANSIT_API');
    if (origin == null) throw const RouteException('NO_ORIGIN');
    if (destinationLatLng == null) throw const RouteException('NO_DESTINATION');
    final budgetMin = budgetMinutes(departure, arrival);

    onProgress?.call(RoutePhase.routing);

    final departureAt = _departureDateTime(departure);
    final body = await _api.fetchGuidanceAt(
      origin,
      destinationLatLng,
      departureAt,
    );
    final options = parseGuidancePlan(body);
    if (options.isEmpty) throw const RouteException('ZERO_RESULTS');

    onProgress?.call(RoutePhase.walkability);

    return _selectMeasured(
      options,
      budgetMin,
      departure,
      origin: origin,
      goal: destinationLatLng,
      onProgress: onProgress,
      fromName: originName,
      toName: destination,
    );
  }

  @override
  void close() => _api.close();

  /// measure-first 選定。標準乗換・実測ハイブリッド・全徒歩を同一土俵で比較し、
  /// 採用候補を Google 実測（enrich）で検証して確定する。徒歩最大化が崩壊したときだけ
  /// 乗車駅探索（引き直し）を1本足して選び直す。
  Future<RoutePlan> _selectMeasured(
    List<TransitOption> options,
    int budgetMin,
    TimeValue departure, {
    required GeoPoint origin,
    required GeoPoint goal,
    void Function(RoutePhase)? onProgress,
    String? fromName,
    String? toName,
  }) async {
    final departureAt = _departureDateTime(departure);
    _diag.log(
      () =>
          '=== plan start: budget=${budgetMin}m departureAt=$departureAt '
          'options=${options.length} ===',
    );
    final walkCache = <String, RouteCandidate>{};
    final measured = <String, int>{};

    // 標準乗換候補（guidance の door-to-door をそのまま候補化）。
    final candidates = <RouteCandidate>[
      for (final o in options)
        RouteCandidate(from: o.from, to: o.to, segments: o.segments),
    ];
    for (final c in candidates) {
      _diag.log(() => 'standard: ${_diag.candLine(c, budgetMin, departureAt)}');
    }

    // 単一最速ではなく路線ファミリの異なる複数 base を土台にする（#292・限界2）。増分 API
    // コストはゼロ（取得済み options を追加で使うだけ）。base ごとのハイブリッドは構造
    // フィンガープリント（[_hybridKey]）でマージ重複除去し、多様化が実測試行を食い合って
    // 最短へ縮退する退行（限界3）を抑える。`measured` は base 間で共有し同一レッグの再計測を畳む。
    final bases = basesForHybrid(options);
    // 崩壊時の board-search は単一 base を土台にする（#137）。先頭は総所要最小＝従来の
    // [_baseForHybrid] と一致するため、崩壊フォールバックの挙動は #292 前と変わらない。
    final base = bases.isEmpty ? null : bases.first;
    if (bases.isNotEmpty) {
      _diag.log(() => 'hybrid bases: ${bases.length}家系');
      // base ごとの実測（マトリクス IO）は互いに独立なので並列に投げる（#163・Codex 指摘）。
      // 逐次だと base 数だけマトリクス往復が数珠つなぎになりユーザー体感が伸びる。`measured` は
      // 共有するが、書き込みは各 await 後に同一値で冪等なので競合しない。
      final built = await Future.wait([
        for (final b in bases)
          _buildCorridorHybrids(
            b,
            origin,
            goal,
            budgetMin,
            departureAt,
            measured,
          ),
      ]);
      final merged = mergeHybrids(
        built,
        (h) => arrivalMinutes(h.segments, departureAt) <= budgetMin,
      );
      candidates.addAll(merged);
      _diag.log(
        () => 'merged hybrids: ${merged.length}件（上限$_maxHybridCandidates）',
      );
    } else {
      _diag.log(() => 'no base route (corridor<2); all-walk only');
      await _measureAccessWalks(origin, goal, const [], const [], measured);
    }

    final allWalk = _measuredWalk(
      origin,
      goal,
      options.first.from,
      options.first.to,
      measured,
    );
    candidates.add(allWalk);
    _diag.log(
      () => 'allWalk: ${_diag.candLine(allWalk, budgetMin, departureAt)}',
    );
    _diag.log(() => 'total candidates: ${candidates.length}');

    // last-resort のバス再照会は高々1回。予算内候補が出ないときにだけ発火するので、
    // 電車で間に合う通常時は Transit API への追加コールが増えない（#250）。
    List<TransitOption>? busOptions;
    List<RouteCandidate>? busCandidates;
    Future<List<RouteCandidate>> lastResortBus() async {
      if (busCandidates != null) return busCandidates!;
      busOptions = await _fetchBusOptions(origin, goal, departureAt);
      return busCandidates = [
        for (final o in busOptions!)
          RouteCandidate(from: o.from, to: o.to, segments: o.segments),
      ];
    }

    var selected = await _selectAndEnrich(
      candidates,
      budgetMin,
      departureAt,
      origin: origin,
      goal: goal,
      walkCache: walkCache,
      lastResortBus: lastResortBus,
    );

    _diag.log(
      () =>
          'selected(initial): '
          'chosen(見積り)=${_diag.candLine(selected.chosen, budgetMin, departureAt)} | '
          'enriched(実測)=${_diag.candLine(selected.enriched, budgetMin, departureAt)}',
    );

    // last-resort のバスが勝ったら、そのバス corridor も徒歩最大化の基準に据える（#251）。
    // 電車が勝った通常時は [busBase] が null のままで、#249 の train-only ガードが効き続ける。
    final busBase = _busBaseFor(selected.chosen, busCandidates, busOptions);

    // 崩壊判定は enrich 前の選定候補（[selected.chosen]）で行う。enrich 後の徒歩は
    // Google 実街路で膨らみ、標準乗換の guidance 見積り徒歩と測定基準がずれるため、
    // 両者を同じ見積り基準で比較しないと崩壊が誤って不成立になる（徒歩最大化の不達）。
    //
    // 比較集合には last-resort のバス option も含める（#251）。バスが勝つのは電車が予算内に
    // 収まらないときなので、電車 option だけを見ると `bestStandardWalk=0` になり
    // `margin=勝者の徒歩` が閾値を超えて崩壊が不成立になる。勝者自身を含む door-to-door
    // 候補群と比べてこそ「乗り通しの標準候補と同じだけしか歩いていない」を検出できる。
    final collapseOptions = busOptions == null
        ? options
        : [...options, ...busOptions!];
    if ((base != null || busBase != null) &&
        _isCollapse(selected.chosen, collapseOptions, budgetMin, departureAt)) {
      _diag.log(() => 'collapse=true → board-search フォールバック起動');
      final extra = <RouteCandidate>[];
      if (base != null) {
        // バスが勝ったときも電車 base の board-search は走らせる。last-resort の発火条件は
        // 「予算外**または乗り遅れ**」（#250）なので、door-to-door では乗り遅れた電車も、
        // より手前の駅から引き直せば後続便で予算内に入ることがある。電車が全滅する状況なら
        // 予算内候補は0件で [extra] に何も足さない＝プールも選定結果も変わらない。
        extra.addAll(
          await _buildBoardSearchCandidate(
            base,
            origin,
            goal,
            budgetMin,
            departureAt,
            walkCache,
          ),
        );
      }
      if (busBase != null) {
        // バス corridor は基準になったのがここが初めてなので、途中乗降ハイブリッドも
        // ここで作る（通常照会の base と違い、事前に作る機会がなかった）。
        _diag.log(() => 'バス corridor を基準に徒歩最大化（#251）');
        extra
          ..addAll(
            await _buildCorridorHybrids(
              busBase,
              origin,
              goal,
              budgetMin,
              departureAt,
              measured,
            ),
          )
          ..addAll(
            await _buildBoardSearchCandidate(
              busBase,
              origin,
              goal,
              budgetMin,
              departureAt,
              walkCache,
            ),
          );
      }
      if (extra.isNotEmpty) {
        _diag.log(() => '徒歩最大化候補: ${extra.length}件をプールへ追加');
        // 既に引いたバス候補（あれば）も再選定のプールへ引き継ぐ。board-search 候補が
        // 逆戻り・乗り遅れ・幽霊便で全滅したとき、last-resort で見つけた予算内のバスへ
        // 戻れるようにするため（引き継がないと予算外の best-effort へ落ちる）。徒歩最大化
        // の観点では乗り通しのバスは徒歩が短いので、生き残る候補があればそちらが勝つ。
        selected = await _selectAndEnrich(
          [...candidates, ...?busCandidates, ...extra],
          budgetMin,
          departureAt,
          origin: origin,
          goal: goal,
          walkCache: walkCache,
          lastResortBus: lastResortBus,
        );
        _diag.log(
          () =>
              'selected(after board-search): '
              '${_diag.candLine(selected.enriched, budgetMin, departureAt)}',
        );
      } else {
        _diag.log(() => '徒歩最大化候補: なし');
      }
    } else if (base != null || busBase != null) {
      _diag.log(() => 'collapse=false → フォールバック起動せず');
    }

    // 代替案の選出・検証は最終 selection が確定してから1回だけ行う（#290 レビュー指摘）。
    // 崩壊時は選定が2回走り1回目の結果は捨てられるため、_selectAndEnrich 内で都度検証
    // すると捨てられる selection のための walk/guidance IO を無駄撃ちする。
    final alternatives = await _validatedAlternatives(
      selected.pool,
      selected.chosen,
      selected.enriched,
      budgetMin,
      departureAt,
      walkCache,
      relaxBudget: selected.relaxBudget,
    );

    final named = await _finalizeStationNames(selected.enriched, departureAt);
    _diag.log(
      () => '=== FINAL: ${_diag.candLine(named, budgetMin, departureAt)} ===',
    );

    return _build(
      named,
      departure,
      budgetMin,
      onProgress,
      fromName: fromName,
      toName: toName,
      alternatives: alternatives,
    );
  }

  /// last-resort のバス option（#250）。`avoidModes` からバスを外して door-to-door を1回だけ
  /// 引き直し、**バス区間を含む option だけ**を返す（バスを含まない option は電車のみの
  /// 主照会と重複するため捨てる）。取得失敗は空リスト＝従来どおり best-effort 縮退へ。
  ///
  /// [RouteCandidate] ではなく [TransitOption] を返すのは、コリドー座標を残して徒歩最大化の
  /// 基準（[_baseForHybrid]）に据えられるようにするため（#251）。
  Future<List<TransitOption>> _fetchBusOptions(
    GeoPoint origin,
    GeoPoint goal,
    DateTime departureAt,
  ) async {
    _diag.log(() => 'バス last-resort: avoidModes からバスを外して再照会');
    final Map<String, dynamic> body;
    try {
      body = await _api.fetchGuidanceAt(
        origin,
        goal,
        departureAt,
        allowBus: true,
      );
    } on RouteException catch (e) {
      _diag.log(() => 'バス last-resort: 再照会失敗 (${e.status})');
      return const [];
    }
    return [
      for (final o in parseGuidancePlan(body))
        if (o.segments.any((s) => s.type == SegmentType.bus)) o,
    ];
  }

  /// 確定経路の transit 区間に乗降地名が無い（コリドー座標由来の候補）ときだけ、その乗車座標
  /// →降車座標で `/guidance/plan` を1回引き直して leg の実駅名・バス停名を復元する（確定候補
  /// のみ・追加コール最小）。続けて隣接徒歩区間の端点へ地名を伝播し、タイムラインの乗車ノード
  /// （直前徒歩の toName を place に使う）と電車・バスカードに地名を出す。
  ///
  /// バス区間も対象にする（#251）。バス corridor 由来のハイブリッドは電車と同様に地名を
  /// 持たないため、train 限定のままだとバス停名が空のまま確定してしまう。
  Future<RouteCandidate> _finalizeStationNames(
    RouteCandidate chosen,
    DateTime departureAt,
  ) async {
    final segs = [...chosen.segments];
    for (var i = 0; i < segs.length; i++) {
      final seg = segs[i];
      if (seg.type == SegmentType.walk) continue;
      if (seg.fromName.isNotEmpty && seg.toName.isNotEmpty) continue;
      if (seg.polyline.length < 2) continue;
      final names = await _fetchTransitEndpoints(
        seg.polyline.first,
        seg.polyline.last,
        departureAt,
        type: seg.type,
      );
      if (names == null) continue;
      segs[i] = seg.copyWith(
        fromName: seg.fromName.isEmpty ? names.from : null,
        toName: seg.toName.isEmpty ? names.to : null,
      );
    }
    _propagateStationNames(segs);
    return RouteCandidate(from: chosen.from, to: chosen.to, segments: segs);
  }

  /// 乗車座標 [board]→降車座標 [alight] を [at] 発で引き直し、最初に [type] の区間を含む
  /// option の、先頭 [type] 区間の乗車地名・実発車時刻と、末尾 [type] 区間の降車地名・実到着
  /// 時刻を返す。該当 option が無い・取得失敗なら null。コリドー由来候補の駅名復元
  /// （[_finalizeStationNames]）と実時刻検証（[_resolveBoardingTimes]・approach A）で共有する。
  ///
  /// 照会モードと拾う leg の型は必ず [type] で揃える（#250）。バス区間の検証に電車のみの
  /// 照会（既定の `avoidModes=bus,...`）を使うと、返ってきた電車の駅名・時刻をバス区間へ
  /// 貼り付けてしまう。
  Future<({String from, String to, DateTime? dep, DateTime? arr})?>
  _fetchTransitEndpoints(
    GeoPoint board,
    GeoPoint alight,
    DateTime at, {
    SegmentType type = SegmentType.train,
  }) async {
    final Map<String, dynamic> body;
    try {
      body = await _api.fetchGuidanceAt(
        board,
        alight,
        at,
        allowBus: type == SegmentType.bus,
      );
    } on RouteException {
      return null;
    }
    for (final o in parseGuidancePlan(body)) {
      final legs = o.segments.where((s) => s.type == type).toList();
      if (legs.isNotEmpty) {
        return (
          from: legs.first.fromName,
          to: legs.last.toName,
          dep: legs.first.depTime,
          arr: legs.last.arrTime,
        );
      }
    }
    return null;
  }

  /// approach A（時刻なしハイブリッドの実時刻検証）。コリドー由来の電車区間は距離概算の
  /// minutes だけを持ち depTime を欠くため、乗車待ち（終電後・運行時間外の翌朝始発待ちを
  /// 含む）が [arrivalMinutes] に反映されず、走っていない電車が予算内へ化ける（#137 実機の
  /// 深夜02:41／全ハイブリッド maxWait=0m）。採用候補の時刻なし transit 区間について、乗車座標
  /// →降車座標を実 boardAt（出発＋その区間までの実累積分）で `/guidance/plan` 引き直しし、
  /// 最初の同種 leg の実発着時刻を当てる。引き直し便は boardAt 以降発の実ダイヤなので、
  /// 乗車待ち・乗車時間が実時刻で入り、深夜は始発待ちで予算外へ正しく落ちる。
  /// boardAt より前発（実ダイヤと不整合・乗れない便）・取得失敗・同種の便なしの区間は当てない。
  /// 駅名も同時に復元する（[_finalizeStationNames] の再照会を省ける）。
  ///
  /// バス区間も同じ検証に掛ける（#250）。実運用ではバス候補は door-to-door の標準乗換
  /// （実時刻付き）としてのみ入るため通常は no-op だが、時刻を欠くバス便が紛れ込んだときに
  /// 電車と同じ基準で幽霊便として弾けるようにする。
  Future<RouteCandidate> _resolveBoardingTimes(
    RouteCandidate cand,
    DateTime departureAt,
  ) async {
    final segs = [...cand.segments];
    var changed = false;
    for (var i = 0; i < segs.length; i++) {
      final seg = segs[i];
      if (seg.type == SegmentType.walk) continue;
      if (seg.depTime != null) continue; // 既に実時刻あり（標準乗換・board-search）
      if (seg.polyline.length < 2) continue;
      final cumBefore = arrivalMinutes(segs.sublist(0, i), departureAt);
      final boardAt = departureAt.add(Duration(minutes: cumBefore));
      // 区間間は並列化しない（#163 対象外）: 後続区間の boardAt（cumBefore）が前区間で
      // 解決した実乗車時間・乗車待ちに依存するため、直列でないと照会時刻がずれる。
      final ep = await _fetchTransitEndpoints(
        seg.polyline.first,
        seg.polyline.last,
        boardAt,
        type: seg.type,
      );
      if (ep == null || ep.dep == null || ep.dep!.isBefore(boardAt)) continue;
      final ride = (ep.arr != null && !ep.arr!.isBefore(ep.dep!))
          ? ep.arr!.difference(ep.dep!).inMinutes
          : seg.minutes;
      segs[i] = seg.copyWith(
        fromName: seg.fromName.isEmpty ? ep.from : null,
        toName: seg.toName.isEmpty ? ep.to : null,
        depTime: ep.dep,
        arrTime: ep.arr,
        minutes: ride,
      );
      changed = true;
    }
    if (!changed) return cand;
    return RouteCandidate(from: cand.from, to: cand.to, segments: segs);
  }

  /// transit 区間（電車・バス）の乗降地名を、直前（乗車側）・直後（降車側）の徒歩区間の端点が
  /// 空のときだけ写す。タイムラインの乗車ノードは直前徒歩の toName、降車後の徒歩は fromName を
  /// place に使うため。出発地・目的地の端（非空）は上書きしない。
  void _propagateStationNames(List<RouteSegment> segs) {
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].type == SegmentType.walk) continue;
      final board = segs[i].fromName;
      final alight = segs[i].toName;
      if (i > 0 &&
          segs[i - 1].type == SegmentType.walk &&
          segs[i - 1].toName.isEmpty &&
          board.isNotEmpty) {
        segs[i - 1] = segs[i - 1].copyWith(toName: board);
      }
      if (i + 1 < segs.length &&
          segs[i + 1].type == SegmentType.walk &&
          segs[i + 1].fromName.isEmpty &&
          alight.isNotEmpty) {
        segs[i + 1] = segs[i + 1].copyWith(fromName: alight);
      }
    }
  }

  /// 候補から決定的に選定し、採用1経路を Google 実測（enrich）で検証する確定ループ。
  /// NAVITIME 版と違い**乗り遅れ再照会（#115）は行わない**：実在便への差し替えはせず、
  /// enrich で (a) 予算超過、または (b) 先頭電車に乗り遅れ（標準乗換のアクセス徒歩が実街路で
  /// 伸び駅着が発車後になる・#137 副次）が判明した候補は除外して乗れる次善へ選び直す。
  /// ハイブリッド／乗車駅探索は引き直しまたは時刻なし距離概算のため `firstMissedTransit` は
  /// 構成上立たず、(b) は主に標準乗換に効く。除外しきれない（プールが1件に痩せた・試行上限）
  /// ときは確定させず best-effort へ縮退する（#254。失格した候補を素通ししない）。
  /// 戻り値の [chosen] は enrich 前の選定候補（guidance 見積り徒歩のまま）、
  /// [enriched] は採用経路を Google 実測で確定したもの。崩壊判定（[_isCollapse]）が
  /// 標準乗換と同じ見積り基準で比較できるよう、両方を返す。
  ///
  /// [lastResortBus] を渡すと、縮退した best-effort が**なお予算外か乗り遅れる**ときに限り
  /// 呼び、得られた候補をプールへ足して選定をやり直す（#250）。バス候補は素の door-to-door
  /// 候補としてプールへ混ざるだけで、逆戻りフィルタ・乗り遅れ除外・幽霊便拒否といった
  /// 既存の検証はそのまま効く。省略時はバスを引かず従来どおり縮退する（再入時がこれ）。
  /// [lastResortBus] はメモ化前提で、既にプールにあるバス候補は積み増さない。
  ///
  /// 代替案（#290）はここでは選ばない。戻り値の [pool]（残存プール）と [relaxBudget] を
  /// 使い、崩壊/board-search 分岐が最終 selection を確定した後に呼び出し側が
  /// [_validatedAlternatives] を1回だけ掛ける（捨てられる selection のための検証 IO を
  /// 発生させないため）。
  Future<_Selection> _selectAndEnrich(
    List<RouteCandidate> candidates,
    int budgetMin,
    DateTime departureAt, {
    required GeoPoint origin,
    required GeoPoint goal,
    required Map<String, RouteCandidate> walkCache,
    Future<List<RouteCandidate>> Function()? lastResortBus,
  }) async {
    /// 縮退。まず従来どおり best-effort を求め、それでも予算外ならバス許容の再照会を
    /// 一度だけ試して候補を足し、選定をやり直す（#250）。
    ///
    /// 「予算内候補なし」で即バスを引かないのは、enrich でプールの見積り予算内候補が
    /// すべて落ちた後にもこの分岐へ来るため。そこには実測で予算内に収まる標準乗換が
    /// 残っていることがあり（best-effort が拾う）、先にバスを引くと電車で間に合うケースで
    /// 追加コールが走ってしまう。判定は「best-effort が実測で使い物になるか」で行う。
    ///
    /// 「使い物になる」は到着が予算内であることに加え、乗り遅れが無いこと。[arrivalMinutes]
    /// は乗り遅れた便を「待ち0で予定どおり乗車」と楽観近似して進めるため、実測徒歩で発車後に
    /// 駅着する経路が予算内に見えてしまう。それを予算内と誤認するとバスを引かず、実際には
    /// 乗れない電車を確定してしまう（#250 レビュー指摘）。
    Future<_Selection> giveUp() async {
      final fallback = await _bestEffortResolved(
        candidates,
        budgetMin,
        departureAt,
        walkCache,
      );
      final segs = fallback.enriched.segments;
      final arrival = arrivalMinutes(segs, departureAt);
      final missed = firstMissedTransit(segs, departureAt) != null;
      // 代替案の予算チェックは best-effort の勝者に適用されたのと同じだけ緩和する
      // （勝者が予算外なら代替案も予算外を許す）。乗り遅れ・時刻なしは緩和しない（#290）。
      _Selection fallbackSelection() => (
        chosen: fallback.chosen,
        enriched: fallback.enriched,
        pool: candidates,
        relaxBudget: arrival > budgetMin,
      );
      if (lastResortBus == null) return fallbackSelection();
      if (arrival <= budgetMin && !missed) {
        _diag.log(() => '  → best-effort が予算内(arr=${arrival}m) → バス再照会せず');
        return fallbackSelection();
      }
      final bus = await lastResortBus();
      // 再入時（バス追加後の選び直しから再び縮退したとき）に同じ候補を積み増さない。
      final fresh = [
        for (final b in bus)
          if (!candidates.any((c) => identical(c, b))) b,
      ];
      if (fresh.isEmpty) {
        _diag.log(() => '  → 追加できるバス候補なし → best-effort のまま');
        return fallbackSelection();
      }
      _diag.log(
        () =>
            '  → best-effort が'
            '${missed ? '乗り遅れ' : '予算外(arr=${arrival}m)'}'
            ' → バス候補 ${fresh.length}件をプールへ追加して選び直し（last-resort）',
      );
      return _selectAndEnrich(
        [...candidates, ...fresh],
        budgetMin,
        departureAt,
        origin: origin,
        goal: goal,
        walkCache: walkCache,
      );
    }

    var pool = candidates;
    for (var attempt = 0; ; attempt++) {
      final chosen = selectBestRoute(
        candidates: pool,
        budgetMin: budgetMin,
        origin: origin,
        goal: goal,
        departureAt: departureAt,
      );
      final withinByEstimate =
          arrivalMinutes(chosen.segments, departureAt) <= budgetMin;
      _diag.log(
        () =>
            'enrich attempt=$attempt pool=${pool.length} '
            'chosen: ${_diag.candLine(chosen, budgetMin, departureAt)}',
      );
      if (!withinByEstimate) {
        _diag.log(() => '  → 予算内候補なし → best-effort 縮退（予算外ならバス last-resort）');
        return await giveUp();
      }

      // enrich（実測徒歩）に加え、時刻なしハイブリッドの電車区間へ実発車時刻を当てる
      // （approach A）。これで乗車待ち（深夜の始発待ち等）が arrivalMinutes に入り、
      // 走っていない電車が予算内へ化けるのを防ぐ。
      final enriched = await _resolveBoardingTimes(
        await _enrichWalkGeometry(chosen, walkCache),
        departureAt,
      );
      // enrich／実時刻検証で (a) 予算超過に転じた、または (b) 先頭電車に乗り遅れる（標準乗換の
      // アクセス徒歩が guidance 見積りより実街路で伸び、駅着が発車後になる）候補は除外して
      // 選び直す。除外は実測の確認時だけ。乗り遅れは「予算内に見えても実際には乗れない」
      // 経路なので、予算超過と同様に確定させない（#137 副次）。
      final violation = _invariantViolation(
        enriched.segments,
        budgetMin,
        departureAt,
      );
      final overBudget = violation.overBudget;
      final missedAfterEnrich = violation.missed;
      final unverifiedTransit = violation.unverified;
      if (attempt < _maxEnrichAttempts &&
          pool.length > 1 &&
          (overBudget || missedAfterEnrich || unverifiedTransit)) {
        _diag.log(
          () =>
              '  → enrich実測で'
              '${overBudget
                  ? '予算超過'
                  : missedAfterEnrich
                  ? '先頭電車に乗り遅れ'
                  : '実発車時刻を確認できず'}'
              '→除外して選び直し: ${_diag.candLine(enriched, budgetMin, departureAt)}',
        );
        pool = pool.where((c) => !identical(c, chosen)).toList();
        continue;
      }
      // 候補を除外しきれなかった（プールが1件に痩せた・attempt 上限）ときは、実測で失格した
      // 候補をそのまま確定させず best-effort（検証済み）へ縮退する（#254）。乗り遅れる便・
      // 予算を超える便・実在の確証が無い便のいずれも「そのまま提示してよい」ものではない。
      // ここも [giveUp] を通す＝best-effort が予算外のときだけバスを引く（#250）。
      if (overBudget || missedAfterEnrich || unverifiedTransit) {
        _diag.log(
          () =>
              '  → 除外しきれず'
              '${overBudget
                  ? '予算超過'
                  : missedAfterEnrich
                  ? '乗り遅れ'
                  : '未確認の便'}'
              'のまま確定不可 → best-effort 縮退（予算外ならバス last-resort）',
        );
        return await giveUp();
      }
      _diag.log(
        () => '  → 確定: ${_diag.candLine(enriched, budgetMin, departureAt)}',
      );
      return (
        chosen: chosen,
        enriched: enriched,
        pool: pool,
        relaxBudget: false,
      );
    }
  }

  /// 勝者確定後の残存プール [pool] のパレート・フロント（非劣解全体）を到着昇順に検証し、
  /// 生き残った代替案を最大 [_maxAlternatives] 件返す（#290）。検証は確定経路と同じ順序
  /// （enrich 実測→実時刻解決→[_invariantViolation]）で、[relaxBudget] のときのみ予算超過を
  /// 許す（best-effort の勝者と同じ緩和）。乗り遅れ・時刻なし transit は緩和しない——乗れない
  /// 便・実在の確証が無い便は代替案としても提示してよいものではないため。
  ///
  /// 上位 [_maxAlternatives] 件だけを検証して終わりにしない：選出候補が検証で落ちたとき、
  /// プールに検証可能な次点の非劣解が残っていても「他の候補」が本来より疎になるため、
  /// 落ちた枠はフロントの次点から補充する。検証は候補ごとに walk/guidance の IO を伴うため、
  /// 通常モードでは見積り予算外の候補を検証前に足切りする——見積りは楽観側に倒す不変条件
  /// （§6・[walkMetersPerMinute]）により、見積りですら予算外なら実測でも通らず、検証する
  /// 価値が無い（best-effort 緩和時は予算チェック自体が緩むので足切りしない）。全滅状況で
  /// フロント全体を検証し尽くさないよう、総検証数は [_maxAlternativeValidations] で打ち切る。
  ///
  /// 検証後は**実測値で**支配関係を掛け直す：enrich・実時刻解決で到着・徒歩が動くと、
  /// 見積りでは非劣解だった候補が勝者や他の検証済み代替案に厳密支配され得る。実測値で
  /// [paretoAlternatives] を再適用（勝者を支配者として含める）し、落ちた分も次点から補充
  /// する。順序・同値除去・勝者同値の除外は再適用が担保する（実測到着の昇順で決定的）。
  Future<List<RouteCandidate>> _validatedAlternatives(
    List<RouteCandidate> pool,
    RouteCandidate chosen,
    RouteCandidate enrichedWinner,
    int budgetMin,
    DateTime departureAt,
    Map<String, RouteCandidate> walkCache, {
    bool relaxBudget = false,
  }) async {
    int arrival(RouteCandidate c) => arrivalMinutes(c.segments, departureAt);
    final front = [
      for (final c in paretoAlternatives(
        candidates: pool,
        chosen: chosen,
        departureAt: departureAt,
        maxCount: pool.length,
      ))
        if (relaxBudget || arrival(c) <= budgetMin) c,
    ];

    Future<RouteCandidate?> validate(RouteCandidate c) async {
      // 例外は候補単位で握って null（落とす）にする。代替案は確定経路の付加情報で、
      // その検証失敗が plan() 全体を失敗させてはならない。rethrow すると壊れた応答
      // 1件で本命の経路まで道連れになる（#290）。
      try {
        final e = await _resolveBoardingTimes(
          await _enrichWalkGeometry(c, walkCache),
          departureAt,
        );
        final v = _invariantViolation(e.segments, budgetMin, departureAt);
        final rejected =
            (v.overBudget && !relaxBudget) || v.missed || v.unverified;
        return rejected ? null : e;
      } catch (_) {
        return null;
      }
    }

    var accepted = <RouteCandidate>[];
    var cursor = 0;
    var validations = 0;
    while (accepted.length < _maxAlternatives &&
        cursor < front.length &&
        validations < _maxAlternativeValidations) {
      var take = _maxAlternatives - accepted.length;
      if (take > front.length - cursor) take = front.length - cursor;
      if (take > _maxAlternativeValidations - validations) {
        take = _maxAlternativeValidations - validations;
      }
      final batch = front.sublist(cursor, cursor + take);
      cursor += take;
      validations += take;
      // バッチ内の検証は互いに独立なので並列に投げる（walkCache 共有で同一レッグは畳む）。
      final validated = await Future.wait([for (final c in batch) validate(c)]);
      accepted.addAll([for (final e in validated) ?e]);
      accepted = paretoAlternatives(
        candidates: [...accepted, enrichedWinner],
        chosen: enrichedWinner,
        departureAt: departureAt,
        maxCount: _maxAlternatives,
      );
    }
    _diag.log(
      () =>
          'alternatives: front=${front.length}件 検証=$validations件 '
          '→ ${accepted.length}件'
          '${relaxBudget ? '（best-effort: 予算チェック緩和）' : ''}',
    );
    return accepted;
  }

  /// enrich／実時刻検証を経た区間列が確定不変条件（#254）に反しているかの3条件判定。
  /// (a) 予算超過（[arrivalMinutes] ベース）、(b) 乗り遅れ（[firstMissedTransit]）、
  /// (c) 実発車時刻を確認できない transit 区間を含む（[hasUnverifiedTransit]・#137 幻便／
  /// #250 幽霊バス）。確定経路（[_selectAndEnrich]）と代替案（#290）が同じ基準で検証する
  /// ための単一実装。
  ({bool overBudget, bool missed, bool unverified}) _invariantViolation(
    List<RouteSegment> segments,
    int budgetMin,
    DateTime departureAt,
  ) => (
    overBudget: arrivalMinutes(segments, departureAt) > budgetMin,
    missed: firstMissedTransit(segments, departureAt) != null,
    unverified: hasUnverifiedTransit(segments),
  );

  /// best-effort 縮退（#121／#137 深夜）。候補へ実発車時刻を当て（approach A）、引き直しでも
  /// 実時刻を確認できなかった時刻なし transit 区間を含む候補（その時間に便が無い疑い＝幻便・
  /// 幽霊バス）を除いたうえで「今夜乗れる範囲の実到着最早」を選ぶ。検証済みが皆無なら元の
  /// 解決済み候補へ戻す（全徒歩は transit を含まず常に残るため通常は空にならない）。
  ///
  /// 選んだ候補は enrich（Google 実街路の徒歩）してから**乗り遅れを測り直す**（#254）。
  /// [_bestEffort] 内の [reachableWithinBudget] は guidance 見積り徒歩に対して
  /// [firstMissedTransit] を見るため、実街路で徒歩が伸びて発車後に駅着する経路を通してしまう。
  /// 実測で乗り遅れが判明した候補は除外して選び直す。全徒歩は transit を含まず決して乗り遅れ
  /// ないので、候補に含まれる限りこのループは必ず「乗れる」候補へ収束する。
  ///
  /// ここに [_maxEnrichAttempts] のような試行上限は**置かない**。プールは毎反復 `identical` で
  /// 厳密に1件減るため停止性は `pool.length` が保証しており、上限は「全徒歩へ到達する前に
  /// 打ち切って乗り遅れ経路を返す」＝この修正が拠って立つ不変条件を壊す方向にしか働かない。
  /// enrich の IO も [walkCache] が同一レッグを1回に畳むため候補数に対して線形以下に収まる。
  ///
  /// 見積りの足切り（[reachableWithinBudget]）はそのまま残す：enrich は候補ごとに Google を
  /// 引く IO なので、安価な見積りで落とせる候補を先に落とすほど実測の回数が減る。
  Future<({RouteCandidate chosen, RouteCandidate enriched})>
  _bestEffortResolved(
    List<RouteCandidate> candidates,
    int budgetMin,
    DateTime departureAt,
    Map<String, RouteCandidate> walkCache,
  ) async {
    // 候補ごとの実時刻解決は互いに独立なので並列に投げる（#163）。候補内の区間ループは
    // 後続区間の boardAt が前区間の解決済み実乗車時間に依存するため直列のまま。
    final resolved = await Future.wait([
      for (final c in candidates) _resolveBoardingTimes(c, departureAt),
    ]);
    final verified = [
      for (final c in resolved)
        if (!hasUnverifiedTransit(c.segments)) c,
    ];
    var pool = verified.isNotEmpty ? verified : resolved;
    while (true) {
      final fallback = _bestEffort(pool, budgetMin, departureAt);
      final enriched = await _enrichWalkGeometry(fallback, walkCache);
      final missed = firstMissedTransit(enriched.segments, departureAt) != null;
      // 予算超過では除外しない：best-effort は「予算内が無いとき」の縮退先なので、超過は
      // 想定内で最早到着こそが選定基準。乗り遅れ（＝そもそも乗れない）だけを除外する。
      if (!missed || pool.length == 1) {
        if (missed) {
          _diag.log(
            () =>
                '  → best-effort: 乗り遅れない候補が尽きた（最後の1件）→ '
                'そのまま縮退: ${_diag.candLine(enriched, budgetMin, departureAt)}',
          );
        }
        return (chosen: fallback, enriched: enriched);
      }
      _diag.log(
        () =>
            '  → best-effort: enrich実測で乗り遅れ→除外して選び直し: '
            '${_diag.candLine(enriched, budgetMin, departureAt)}',
      );
      pool = pool.where((c) => !identical(c, fallback)).toList();
    }
  }

  /// 予算内候補が無いときの縮退先（#121）。「今夜乗れる」範囲の実到着最早を返す。
  RouteCandidate _bestEffort(
    List<RouteCandidate> candidates,
    int budgetMin,
    DateTime departureAt,
  ) {
    final pool =
        reachableWithinBudget(candidates, budgetMin, departureAt) ?? candidates;
    return pool.reduce(
      (a, b) =>
          arrivalMinutes(a.segments, departureAt) <=
              arrivalMinutes(b.segments, departureAt)
          ? a
          : b,
    );
  }

  /// 確定 [winner] が徒歩最大化の崩壊（§7）かを判定する。(1) 予算内標準乗換の最大徒歩を
  /// [_collapseWalkMarginMin] 以下しか上回らない、(2) 予算を相対（[_collapseSlackRatio]）
  /// または絶対（[_collapseSlackMinutes]）のいずれかの閾値以上余らせている、の両方を満たす
  /// とき true。best-effort（予算外）は対象外。
  ///
  /// [options] は「[winner] が属する door-to-door 候補群」を渡す（#251）。last-resort の
  /// バスが勝ったときは電車 option に加えバス option も含める。含めないと予算内の電車が
  /// 無い状況で `bestStandardWalk=0` となり、バスのアクセス徒歩がそのまま margin になって
  /// 崩壊が不成立になる＝バスに乗り通したまま予算を余らせる。閾値は変えない。
  bool _isCollapse(
    RouteCandidate winner,
    List<TransitOption> options,
    int budgetMin,
    DateTime departureAt,
  ) {
    final arrival = arrivalMinutes(winner.segments, departureAt);
    if (arrival > budgetMin) {
      _diag.log(
        () => 'collapse判定: 予算外(arr=${arrival}m>budget=${budgetMin}m)→対象外',
      );
      return false;
    }
    final slack = budgetMin - arrival;
    final relativeThreshold = budgetMin * _collapseSlackRatio;
    // 相対（予算の割合）・絶対（分）のいずれかを満たせば「予算が大きく余っている」。
    if (slack < relativeThreshold && slack < _collapseSlackMinutes) {
      _diag.log(
        () =>
            'collapse判定: 症状(2)未達 slack=${slack}m < '
            '相対閾値=${relativeThreshold.toStringAsFixed(1)}m'
            '(=${budgetMin}m×$_collapseSlackRatio) かつ < '
            '絶対閾値=${_collapseSlackMinutes}m →起動せず',
      );
      return false;
    }
    var bestStandardWalk = 0;
    for (final o in options) {
      final c = RouteCandidate(from: o.from, to: o.to, segments: o.segments);
      if (arrivalMinutes(c.segments, departureAt) <= budgetMin &&
          c.walkMinutes > bestStandardWalk) {
        bestStandardWalk = c.walkMinutes;
      }
    }
    final margin = winner.walkMinutes - bestStandardWalk;
    final result = margin <= _collapseWalkMarginMin;
    _diag.log(
      () =>
          'collapse判定: slack=${slack}m(≥閾値) '
          'winnerWalk=${winner.walkMinutes}m bestStandardWalk=${bestStandardWalk}m '
          'margin=${margin}m ${result ? '≤' : '>'} $_collapseWalkMarginMin '
          '→症状(1)=${result ? '達' : '未達'} → collapse=$result',
    );
    return result;
  }

  /// 乗車駅探索（docs/notes/walk-max-board-search.md / transit-api-migration.md §2.5）。
  /// [base] のコリドー座標を乗車駅候補（前半徒歩 t1 の昇順）とし、各点 X から
  /// `/guidance/plan(X→goal, departureAt+t1)` を引き直して「到着が予算内の最遠＝総徒歩
  /// 最大」を [maxWalkBoardingIndexParallel]（k分割並列探索・#163）で探索する。各ラウンド
  /// [_boardSearchFanout] 点を同時評価して Transit API レイテンシの直列積み上げを避ける。
  /// 評価点の集合は直列二分探索と異なるため、戻り値の候補群も直列版と変わり得る。
  /// 引き直し便は X 発で自己整合なので `firstMissedTransit` が立たない。コリドー候補は
  /// 2未満／予算内が無いとき null。
  ///
  /// **前半徒歩は Google 実街路で実測して二分探索を駆動する（#137 主因の修正）。** 直線推定
  /// は実街路に対し大きく楽観に倒れることがあり（実機で -36分・25%）、それで二分探索を
  /// 駆動すると目的地寄りの遠い乗車駅へ収束→実街路では全部予算超過→予算内の確定に失敗して
  /// 徒歩最小の標準乗換へ崩落（大量の余り）していた。実測で駆動すれば、二分探索の各評価点は
  /// 実測で予算内可否が確定する。実測は [walkCache] 共有で、採用後の enrich でも同一レッグは
  /// キャッシュヒットし到着は覆らない。
  ///
  /// **戻り値は二分探索が評価した予算内候補を「全部」返す（#137）。** 単一の最良1本だけを返すと、
  /// それが下流の逆戻りフィルタ・乗り遅れ除外（[selectBestRoute]/[_selectAndEnrich]）で消えた
  /// とき次善の board-search 候補へ落ちられず徒歩最小へ転落する（実機: 川崎(徒歩74)が逆戻りで
  /// 弾かれ鹿島田(徒歩68)に落ちず徒歩12へ）。全候補をプールへ足せば、逆戻り・到着の非単調も
  /// 込みで「生き残る中の徒歩最大」を選定が決められる。コリドー2未満・予算内皆無は空リスト。
  Future<List<RouteCandidate>> _buildBoardSearchCandidate(
    TransitOption base,
    GeoPoint origin,
    GeoPoint goal,
    int budgetMin,
    DateTime departureAt,
    Map<String, RouteCandidate> walkCache,
  ) async {
    final stops = _corridorStops(base);
    if (stops.length < 2) return const [];
    // 引き直しの照会モードは基準コリドーの種別に揃える（#251）。
    final allowBus = base.segments.any((s) => s.type == SegmentType.bus);

    // 探索が同じ index を再評価しても引き直さないようメモ化する。同一ラウンド内の
    // 評価点は重複除去済み（[maxWalkBoardingIndexParallel]）なので同時実行は衝突しない。
    final built = <int, RouteCandidate?>{};
    Future<RouteCandidate?> buildAt(int i) async {
      if (built.containsKey(i)) return built[i];
      final x = stops[i];
      // 前半徒歩は実測（失敗時のみ直線推定へフォールバック）。
      final walk1 =
          await _tryWalk(
            origin,
            x.coord,
            fromName: base.from,
            toName: '',
            cache: walkCache,
          ) ??
          _estimateWalk(origin, x.coord, fromName: base.from, toName: '');
      final boardAt = departureAt.add(Duration(minutes: walk1.totalMin));
      final xToGoal = await _fetchTransitFrom(
        x.coord,
        goal,
        boardAt,
        allowBus: allowBus,
      );
      if (xToGoal == null) {
        _diag.log(
          () => 'board-search i=$i walk1=${walk1.totalMin}m guidance失敗',
        );
        return built[i] = null;
      }
      final walk1Seg = walk1.segments.first;
      final cand = RouteCandidate(
        from: base.from,
        to: xToGoal.to,
        segments: [if (walk1Seg.minutes > 0) walk1Seg, ...xToGoal.segments],
      );
      _diag.log(
        () =>
            'board-search i=$i walk1=${walk1.totalMin}m '
            '乗車駅=${_diag.boardingStationOf(cand)} '
            '${_diag.candLine(cand, budgetMin, departureAt)}',
      );
      return built[i] = cand;
    }

    // 実測到着が index 単調増の前提で「到着が予算内の最遠 index ＝総徒歩最大」を探索。
    // k分割並列版（#163）: 各ラウンドで _boardSearchFanout 点を同時評価し、Transit API
    // レイテンシ（1コール2〜10秒）の数珠つなぎを「ラウンド数×最遅1本」へ縮める。
    // 評価点の集合は直列二分探索と異なるため、プールへ足す候補（下の within）も変わり得る。
    final best = await maxWalkBoardingIndexParallel(
      count: stops.length,
      budgetMin: budgetMin,
      fanout: _boardSearchFanout,
      evaluate: (i) async {
        final c = await buildAt(i);
        // 経路無し（引き直し失敗）は予算外として扱い、手前の駅を探す。
        return c == null
            ? budgetMin + (1 << 20)
            : arrivalMinutes(c.segments, departureAt);
      },
    );
    _diag.log(
      () =>
          'board-search: 実測k分割並列探索の境界 best='
          '${best == null ? 'null(予算内乗車駅なし)' : '$best'} / コリドー点${stops.length}',
    );
    // 探索が評価した点（メモ化済み）のうち、予算内の候補を「全部」返す。境界 best 1本だけ
    // でなく全部を返すのは：(1) 到着は実街路で非単調になり得る（後方の停車駅が origin に近い等）
    // ため境界＝徒歩最大とは限らず、(2) 採用前に逆戻りフィルタ・乗り遅れ除外で1本が消えても、
    // 次善の board-search 候補へ落とせるようにするため。選定（[selectBestRoute] /
    // [_selectAndEnrich]）が逆戻り・到着の非単調を込みで「生き残る中の徒歩最大」を決める。
    final within = [
      for (final c in built.values)
        if (c != null && arrivalMinutes(c.segments, departureAt) <= budgetMin)
          c,
    ];
    _diag.log(() => 'board-search: 予算内候補 ${within.length}件を返す');
    return within;
  }

  /// 乗降アクセス徒歩を1回（最大2コール）のマトリクス（Google プロキシ）で一括実測し、
  /// [measured] にレッグキー→徒歩分で格納する。goal を乗車側 destinations 末尾に相乗り
  /// させ全徒歩(origin→goal)も同時に測る。失敗レッグは未格納（直線推定へフォールバック）。
  Future<void> _measureAccessWalks(
    GeoPoint origin,
    GeoPoint goal,
    List<GeoPoint> boardStops,
    List<GeoPoint> alightStops,
    Map<String, int> measured,
  ) async {
    // 乗車側・降車側のマトリクスは互いに独立なので並列に投げる（#163）。
    final boardDests = [...boardStops, goal];
    final boardFuture = _api.fetchWalkMatrix([origin], boardDests);
    final alightFuture = alightStops.isEmpty
        ? Future<List<dynamic>?>.value(null)
        : _api.fetchWalkMatrix(alightStops, [goal]);
    final boardRows = await boardFuture;
    final alightRows = await alightFuture;
    if (boardRows != null) {
      for (final e in boardRows) {
        if (e is! Map) continue;
        final di = (e['destinationIndex'] as num?)?.toInt() ?? 0;
        final min = _parseDurationMin(e['duration']);
        if (min == null || di < 0 || di >= boardDests.length) continue;
        measured[_walkCacheKey(origin, boardDests[di])] = min;
      }
    }
    if (alightRows != null) {
      for (final e in alightRows) {
        if (e is! Map) continue;
        final oi = (e['originIndex'] as num?)?.toInt() ?? 0;
        final min = _parseDurationMin(e['duration']);
        if (min == null || oi < 0 || oi >= alightStops.length) continue;
        measured[_walkCacheKey(alightStops[oi], goal)] = min;
      }
    }
  }

  /// [base] のコリドーからフロンティアを絞り、アクセス徒歩を一括実測してハイブリッド候補を
  /// 作る（途中乗降＝徒歩最大化の主経路）。[measured] は呼び出し間で共有し、全徒歩
  /// (origin→goal) のレッグもここで測る。
  Future<List<RouteCandidate>> _buildCorridorHybrids(
    TransitOption base,
    GeoPoint origin,
    GeoPoint goal,
    int budgetMin,
    DateTime departureAt,
    Map<String, int> measured,
  ) async {
    final stops = _corridorStops(base);
    final frontier = frontierStations(
      [for (final s in stops) s.coord],
      origin,
      goal,
      budgetMin,
      maxPerSide: _maxMatrixSideStations,
    );
    final baseMin = base.segments.fold(0, (a, s) => a + s.minutes);
    _diag.log(
      () =>
          'base route: totalMin=${baseMin}m corridorStops=${stops.length} '
          'frontier.boarding=${frontier.boarding} '
          'alighting=${frontier.alighting}',
    );
    await _measureAccessWalks(
      origin,
      goal,
      [for (final i in frontier.boarding) stops[i].coord],
      [for (final i in frontier.alighting) stops[i].coord],
      measured,
    );
    _diag.log(
      () =>
          'measured ${measured.length} legs; '
          'allWalk(origin->goal)=${measured[_walkCacheKey(origin, goal)]}m '
          '(null=matrix失敗→直線推定へ)',
    );
    final hybrids = _buildMeasuredHybrids(
      base,
      stops,
      frontier,
      measured,
      origin,
      goal,
    );
    _diag.log(() => 'built ${hybrids.length} hybrids:');
    for (final c in hybrids) {
      _diag.log(() => '  hybrid: ${_diag.candLine(c, budgetMin, departureAt)}');
    }
    return hybrids;
  }

  /// フロンティアの乗車駅 b → 降車駅 a（同一コリドー・b より後方）の分割を、実測アクセス
  /// 徒歩で候補化する。コリドー座標は時刻を持たないため乗車時間は折れ線長から距離概算
  /// （#67 と同じ untimed 経路）、運賃は取得不可のため null（§5）。
  List<RouteCandidate> _buildMeasuredHybrids(
    TransitOption base,
    List<_CorridorStop> stops,
    ({List<int> boarding, List<int> alighting}) frontier,
    Map<String, int> measured,
    GeoPoint origin,
    GeoPoint goal,
  ) {
    final result = <RouteCandidate>[];
    for (final b in frontier.boarding) {
      final walk1 = _measuredWalkSeg(
        origin,
        stops[b].coord,
        base.from,
        stops[b].name,
        measured,
      );
      for (final a in frontier.alighting) {
        if (a <= b) continue;
        // 乗換をまたぐ b→a は単一乗車として表現できないため同一コリドーのみ。
        if (stops[a].section != stops[b].section) continue;
        final rideKm = _railKm(stops, b, a);
        // バス corridor でも [trainMetersPerMinute] のまま概算する（#251）。実効速度は
        // バスの方が遅いが、見積りは楽観側に倒すのが選定の不変条件（§6・[walkMetersPerMinute]
        // の docstring）。enrich／実時刻検証は「見積りで予算内の候補」を落とす方向にしか
        // 働かないため、実速度で厳しく見積もると実ダイヤなら間に合うバスを選定段階で捨てて
        // しまい回収できない。乗車時間は採用前に [_resolveBoardingTimes] が実時刻で上書きする。
        final ride = (rideKm * 1000 / trainMetersPerMinute).round();
        if (ride < 0) continue;
        final walk2 = _measuredWalkSeg(
          stops[a].coord,
          goal,
          stops[a].name,
          base.to,
          measured,
        );
        result.add(
          RouteCandidate(
            from: base.from,
            to: base.to,
            segments: <RouteSegment>[
              if (walk1.minutes > 0) walk1,
              RouteSegment(
                type: stops[b].type,
                fromName: stops[b].name,
                toName: stops[a].name,
                minutes: ride,
                km: rideKm,
                line: stops[b].line,
                stops: a - b,
                polyline: [for (var i = b; i <= a; i++) stops[i].coord],
              ),
              if (walk2.minutes > 0) walk2,
            ],
          ),
        );
      }
    }
    return result;
  }

  /// 徒歩区間 [a]→[b] を実測分（[measured] にあれば）で、無ければ直線推定で作る。
  RouteSegment _measuredWalkSeg(
    GeoPoint a,
    GeoPoint b,
    String fromName,
    String toName,
    Map<String, int> measured,
  ) {
    final est = _estimateWalk(
      a,
      b,
      fromName: fromName,
      toName: toName,
    ).segments.first;
    final min = measured[_walkCacheKey(a, b)];
    if (min == null || est.minutes == 0) return est;
    return RouteSegment(
      type: SegmentType.walk,
      fromName: fromName,
      toName: toName,
      minutes: min,
      km: est.km,
      kcal: est.kcal,
      polyline: est.polyline,
    );
  }

  /// 全徒歩候補を実測分（無ければ直線推定）で作る。
  RouteCandidate _measuredWalk(
    GeoPoint origin,
    GeoPoint goal,
    String fromName,
    String toName,
    Map<String, int> measured,
  ) => RouteCandidate(
    from: fromName,
    to: toName,
    segments: [_measuredWalkSeg(origin, goal, fromName, toName, measured)],
  );

  /// 確定経路の徒歩区間を Google Routes の街路ジオメトリ・所要・距離で上書きする。
  /// 取得失敗時は元（guidance の polyline / 直線）を保つ。
  Future<RouteCandidate> _enrichWalkGeometry(
    RouteCandidate chosen,
    Map<String, RouteCandidate> cache,
  ) async {
    // 徒歩区間の実測は互いに独立なので並列に投げる（#163）。取得失敗（null）は
    // 従来どおり元の区間を保つ。
    final segments = await Future.wait([
      for (final seg in chosen.segments)
        if (seg.type != SegmentType.walk || seg.polyline.length < 2)
          Future.value(seg)
        else
          _tryWalk(
            seg.polyline.first,
            seg.polyline.last,
            fromName: seg.fromName,
            toName: seg.toName,
            cache: cache,
          ).then((walk) => walk?.segments.first ?? seg),
    ]);
    return RouteCandidate(from: chosen.from, to: chosen.to, segments: segments);
  }

  RoutePlan _build(
    RouteCandidate chosen,
    TimeValue departure,
    int budgetMin,
    void Function(RoutePhase)? onProgress, {
    String? fromName,
    String? toName,
    List<RouteCandidate> alternatives = const [],
  }) {
    onProgress?.call(RoutePhase.building);
    final departureAt = _departureDateTime(departure);
    return buildRoutePlan(
      from: _displayName(fromName, chosen.from),
      to: _displayName(toName, chosen.to),
      segments: chosen.segments,
      departure: departure,
      budgetMin: budgetMin,
      departureAt: departureAt,
      alternatives: [
        for (final a in alternatives)
          buildRoutePlan(
            from: _displayName(fromName, a.from),
            to: _displayName(toName, a.to),
            segments: a.segments,
            departure: departure,
            budgetMin: budgetMin,
            departureAt: departureAt,
          ),
      ],
    );
  }

  String _displayName(String? override, String fallback) {
    final name = override?.trim();
    return (name != null && name.isNotEmpty) ? name : fallback;
  }

  /// 徒歩最大化の基準に据えるバス corridor（#251）。**勝者自身が乗っているバス便**の
  /// option を返す。バスが勝っていない（＝last-resort を引いていない・電車が勝った）
  /// ときは null で、#249 の train-only ガードが効き続ける。
  ///
  /// 最短のバス option を選んではいけない。last-resort が複数のバス便を返すとき、選定の
  /// 目的関数は「徒歩最大」なのに [_baseForHybrid] の基準は「総所要最小」なので両者は
  /// 食い違う。勝者と別の corridor を基準にすると、乗車バス停探索が勝者と無関係な停留所を
  /// 引き直して空振りし、勝ったバスは乗り通しのまま予算を余らせる。
  ///
  /// [selectBestRoute] はプールの要素をそのまま返すので、勝者は参照で [busCandidates] に
  /// 対応付けられる。対応付かないのは best-effort 縮退（[_resolveBoardingTimes] が実時刻を
  /// 当てたコピーを作る）経由で勝ったときだけ。そのときは予算外＝[_isCollapse] が対象外に
  /// するため基準は使われないが、従来どおり最短 option へフォールバックしておく。
  TransitOption? _busBaseFor(
    RouteCandidate winner,
    List<RouteCandidate>? busCandidates,
    List<TransitOption>? busOptions,
  ) {
    if (busOptions == null) return null;
    if (!winner.segments.any((s) => s.type == SegmentType.bus)) return null;
    final i = busCandidates?.indexWhere((c) => identical(c, winner)) ?? -1;
    final scope = i >= 0 ? [busOptions[i]] : busOptions;
    return _baseForHybrid(scope, allowBus: true);
  }

  /// コリドー（停車駅／線路点・バス停）を持つ最短の標準経路をハイブリッド・乗車駅探索の
  /// 基準にする。
  ///
  /// 既定ではバス混在 option を基準にしない（#249）。電車で予算内に収まる通常照会では
  /// バス corridor を基準に据える理由がなく、避けたバスが徒歩最大化の裏口から戻ってくる
  /// のを防ぐため。[allowBus] を立てるのは last-resort 再照会で得たバス option を基準に
  /// するときだけ（#251・[_busBaseFor] 経由）。
  TransitOption? _baseForHybrid(
    List<TransitOption> options, {
    bool allowBus = false,
  }) {
    TransitOption? best;
    int? bestMin;
    for (final o in options) {
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      if (!allowBus && o.segments.any((s) => s.type == SegmentType.bus)) {
        continue;
      }
      final min = o.segments.fold(0, (a, s) => a + s.minutes);
      if (best == null || min < bestMin!) {
        best = o;
        bestMin = min;
      }
    }
    return best;
  }

  /// ハイブリッドの土台に据える「路線ファミリの異なる代表 base」群（#292）。単一最速1本
  /// （[_baseForHybrid]）では別路線コリドー由来の徒歩多め候補が原理的に生成されない（限界2）。
  /// baseline の option 群を routeName 集合（[_routeFamilyKey]）でフィンガープリントして
  /// ファミリごとにまとめ、各ファミリの代表を最大 [_maxHybridBases] 本返す。**増分 API コストは
  /// ゼロ**——既に取得済みの単一 `/guidance/plan` レスポンスの option を追加で土台にするだけで、
  /// 新規照会は発行しない（#288 §4：素材は1回の照会に既に入っている）。
  ///
  /// ファミリ内の代表は現行の総所要 `minutes` 最小を踏襲する（限界1＝目的関数が徒歩 km か min かは
  /// 本 issue のスコープ外・#288）。ファミリ間の順序は総所要昇順、**同所要は代表 option の出現順**を
  /// タイブレークにする——[List.sort] は等価な相異要素の順序を保証しないため、これを入れないと
  /// 同所要のファミリで [bases].first が [_baseForHybrid]（出現順で最初の最短を採る）と食い違い、
  /// 崩壊時 board-search の基準コリドーが #292 前と変わってしまう（Codex 指摘）。タイブレークは
  /// ファミリの初出位置ではなく**代表（最短）option の位置**で行う——初出位置だと `A(20m),B(10m),
  /// A(10m)` で `_baseForHybrid` が B を採るのに A が先に来てしまう（Codex 指摘）。この順序保証で
  /// **先頭は [_baseForHybrid] の単一最速 base に一致し、単一ファミリのときは挙動が変わらない**。
  /// バス除外・コリドー2点未満除外のガードは [_baseForHybrid] と同一（main path は電車のみ）。
  @visibleForTesting
  List<TransitOption> basesForHybrid(List<TransitOption> options) {
    final repByFamily = <String, TransitOption>{};
    final minByFamily = <String, int>{};
    final repIndexByFamily = <String, int>{};
    for (var i = 0; i < options.length; i++) {
      final o = options[i];
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      if (o.segments.any((s) => s.type == SegmentType.bus)) continue;
      final key = _routeFamilyKey(o);
      final min = o.segments.fold(0, (a, s) => a + s.minutes);
      if (!minByFamily.containsKey(key) || min < minByFamily[key]!) {
        repByFamily[key] = o;
        minByFamily[key] = min;
        repIndexByFamily[key] = i;
      }
    }
    final families = repByFamily.keys.toList()
      ..sort((a, b) {
        final byMin = minByFamily[a]!.compareTo(minByFamily[b]!);
        return byMin != 0
            ? byMin
            : repIndexByFamily[a]!.compareTo(repIndexByFamily[b]!);
      });
    return [for (final k in families.take(_maxHybridBases)) repByFamily[k]!];
  }

  /// option を路線ファミリへ要約するフィンガープリント（#292）。transit 区間（電車・バス）の
  /// 路線名の集合（順不同・重複除去・ソート）で表す。同じ路線集合を通る option（捕まえる便
  /// だけが違う等）は同一ファミリとして1本に畳み、別路線を経由する option だけを別 base に
  /// する。素朴な「時間で上位N本」だと同一ファミリの重複を掴むだけで多様性が増えない（#288）。
  ///
  /// 路線名を欠く leg はコリドー形状で代替する。路線名が空（`routeName` 無し＝
  /// [RouteSegment.line] が null、または Transit API が `routeName: ""` を返す空文字）だと、
  /// 全部が同じキーへ畳まれて別コリドーが同一ファミリ扱いになり最速1本しか残らず、多様化が
  /// 静かに単一 base へ退行してしまう（Codex 指摘）。null も空文字も等しく「無名」とみなし、
  /// コリドー形状へフォールバックする。端点だけだと同一 OD の急行・各停のように端点を共有し
  /// 途中だけ違うコリドーを区別できないため、polyline を均等サンプルした座標列で表す
  /// （[_corridorFingerprintSamples] 点）。
  String _routeFamilyKey(TransitOption o) {
    final keys = <String>{
      for (final s in o.segments)
        if (s.type == SegmentType.train || s.type == SegmentType.bus)
          (s.line == null || s.line!.isEmpty)
              ? '@${_corridorFingerprint(s.polyline)}'
              : s.line!,
    }.toList()..sort();
    return keys.join('|');
  }

  /// 路線名を欠くコリドーのフィンガープリント。polyline を均等サンプルした座標列で、
  /// 端点を共有し途中だけ違うコリドー（同一 OD の急行/各停等）も区別する（[_routeFamilyKey]）。
  String _corridorFingerprint(List<GeoPoint> polyline) => [
    for (final p in evenSample(polyline, _corridorFingerprintSamples))
      _coordKey(p),
  ].join(',');

  static const int _corridorFingerprintSamples = 8;

  /// ハイブリッド候補を構造フィンガープリントへ要約し、複数 base 由来の同一候補を
  /// マージ時に重複除去する（#292）。乗降駅名は生成時点では空のことがあるため、区間の
  /// 種別・路線名と polyline 端点（5桁丸め）で表す——同じコリドー区間を同じ乗降座標で
  /// 通る候補は同一とみなす。座標丸めは徒歩レッグキャッシュ（[_walkCacheKey]）と同じ精度。
  String _hybridKey(RouteCandidate c) => [
    for (final s in c.segments)
      '${s.type.name}:${s.line ?? ''}:'
          '${_coordKey(s.polyline.isNotEmpty ? s.polyline.first : null)}>'
          '${_coordKey(s.polyline.isNotEmpty ? s.polyline.last : null)}',
  ].join('|');

  String _coordKey(GeoPoint? p) => p == null
      ? '-'
      : '${p.lat.toStringAsFixed(5)},${p.lng.toStringAsFixed(5)}';

  /// base ごとのハイブリッド群（[perBase]）を [_maxHybridCandidates] 本までマージ重複除去する
  /// （#292）。[within]（見積り到着が予算内か）が true の候補を**先に**上限まで詰め、余枠にのみ
  /// 予算外を足す。予算外の徒歩多め候補が上限を食い潰し、単一 base 時代なら選定へ渡っていた
  /// 予算内の短めハイブリッドを締め出して標準乗換/全徒歩へ縮退させる退行を防ぐ（Codex 指摘）。
  /// 各フェーズ内は base 間ラウンドロビン（各 base は徒歩多い順）で、1ファミリの候補群が他
  /// ファミリを締め出さないようにする（限界3）。[_hybridKey] で同一候補を除去する。
  @visibleForTesting
  List<RouteCandidate> mergeHybrids(
    List<List<RouteCandidate>> perBase,
    bool Function(RouteCandidate) within,
  ) {
    final sorted = [
      for (final list in perBase)
        [...list]..sort((a, b) => b.walkMinutes.compareTo(a.walkMinutes)),
    ];
    final seen = <String>{};
    final out = <RouteCandidate>[];
    for (final keepWithin in const [true, false]) {
      final phase = [
        for (final list in sorted)
          [
            for (final h in list)
              if (within(h) == keepWithin) h,
          ],
      ];
      for (var rank = 0; out.length < _maxHybridCandidates; rank++) {
        var progressed = false;
        for (final list in phase) {
          if (rank >= list.length) continue;
          progressed = true;
          if (seen.add(_hybridKey(list[rank]))) out.add(list[rank]);
          if (out.length >= _maxHybridCandidates) break;
        }
        if (!progressed) break;
      }
      if (out.length >= _maxHybridCandidates) break;
    }
    return out;
  }

  /// [base] の全コリドー座標を origin→goal 方向に連結し、乗車駅候補（[_CorridorStop]）へ
  /// 変換する。gtfsShape は頂点が密なため均等間引きで [_maxCorridorStops] 以下へ絞る（§2.5）。
  /// section は transit leg（電車・バス問わず）番号、line/type は対応するセグメントの
  /// 路線名・種別。`TransitCorridor.legIndex` は全 transit leg の通し番号のため、対応する
  /// セグメント列も train に絞らず transit 全体（電車・バス）で揃える（#249: train のみに
  /// 絞ると bus leg を挟んだ後続の legIndex がズレて誤った路線名を拾っていた）。
  List<_CorridorStop> _corridorStops(TransitOption base) {
    final transitSegs = [
      for (final s in base.segments)
        if (s.type == SegmentType.train || s.type == SegmentType.bus) s,
    ];
    final out = <_CorridorStop>[];
    for (final c in base.corridors) {
      final seg = c.legIndex < transitSegs.length
          ? transitSegs[c.legIndex]
          : null;
      for (final p in evenSample(c.coords, _maxCorridorStops)) {
        out.add(
          _CorridorStop(
            coord: p,
            section: c.legIndex,
            line: seg?.line,
            type: seg?.type ?? SegmentType.train,
          ),
        );
      }
    }
    return out;
  }

  /// コリドー区間 [b]→[a]（同一 section・連続インデックス）の折れ線長（km）。
  double _railKm(List<_CorridorStop> stops, int b, int a) {
    var km = 0.0;
    for (var i = b; i < a; i++) {
      km += haversineKm(stops[i].coord, stops[i + 1].coord);
    }
    return km;
  }

  // ---- Transit API（[TransitApiClient] 経由の引き直し） ----

  /// 乗車駅候補 X から goal への経路を引き直し、最初に transit 区間を含む option を
  /// [RouteCandidate] で返す（乗車駅探索の評価関数）。全徒歩しか返らなければ null。
  ///
  /// [allowBus] は基準コリドーの種別に揃える（#251）。バス corridor の乗車駅探索でバスを
  /// 除外して引くと、バス停 X からの経路が全徒歩に落ちて探索が空振りする。
  Future<RouteCandidate?> _fetchTransitFrom(
    GeoPoint x,
    GeoPoint goal,
    DateTime at, {
    bool allowBus = false,
  }) async {
    final Map<String, dynamic> body;
    try {
      body = await _api.fetchGuidanceAt(x, goal, at, allowBus: allowBus);
    } on RouteException {
      return null;
    }
    for (final o in parseGuidancePlan(body)) {
      if (o.segments.any((s) => s.type != SegmentType.walk)) {
        return RouteCandidate(from: o.from, to: o.to, segments: o.segments);
      }
    }
    return null;
  }

  // ---- Google Routes（[TransitApiClient] 経由の徒歩実測をドメイン候補へ変換） ----

  /// origin→dest の徒歩を Google Routes(WALK, プロキシ経由)で取得して徒歩区間候補にする。
  /// レッグ単位キャッシュ（座標5桁丸めキー）。失敗時は null。
  Future<RouteCandidate?> _tryWalk(
    GeoPoint origin,
    GeoPoint dest, {
    required String fromName,
    required String toName,
    Map<String, RouteCandidate>? cache,
  }) async {
    if (cache != null) {
      final hit = cache[_walkCacheKey(origin, dest)];
      if (hit != null) return _renameWalk(hit, fromName, toName);
    }
    try {
      final body = await _api.fetchWalkRoute(origin, dest);
      final routes = body['routes'] as List<dynamic>? ?? const [];
      if (routes.isEmpty) return null;
      final route = routes.first as Map<String, dynamic>;
      final minutes = _parseDurationMin(route['duration']);
      if (minutes == null) return null;
      final km = ((route['distanceMeters'] as num?)?.toInt() ?? 0) / 1000.0;
      final shape = _parseEncodedPolyline(route['polyline']);
      final result = RouteCandidate(
        from: fromName,
        to: toName,
        segments: [
          RouteSegment(
            type: SegmentType.walk,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            kcal: (km * kcalPerKm).round(),
            polyline: shape.isNotEmpty ? shape : [origin, dest],
          ),
        ],
      );
      if (cache != null) cache[_walkCacheKey(origin, dest)] = result;
      return result;
    } on RouteException {
      return null;
    }
  }

  RouteCandidate _renameWalk(
    RouteCandidate cached,
    String fromName,
    String toName,
  ) => RouteCandidate(
    from: fromName,
    to: toName,
    segments: [
      cached.segments.first.copyWith(fromName: fromName, toName: toName),
    ],
  );

  /// origin→dest を直線距離から推定した徒歩区間候補にする（API 呼び出しなし）。
  RouteCandidate _estimateWalk(
    GeoPoint origin,
    GeoPoint dest, {
    required String fromName,
    required String toName,
  }) {
    final km = haversineKm(origin, dest);
    final minutes = (km * 1000 / walkMetersPerMinute).round();
    return RouteCandidate(
      from: fromName,
      to: toName,
      segments: [
        RouteSegment(
          type: SegmentType.walk,
          fromName: fromName,
          toName: toName,
          minutes: minutes,
          km: km,
          kcal: (km * kcalPerKm).round(),
          polyline: [origin, dest],
        ),
      ],
    );
  }

  String _walkCacheKey(GeoPoint origin, GeoPoint dest) =>
      '${origin.lat.toStringAsFixed(5)},${origin.lng.toStringAsFixed(5)}'
      '|${dest.lat.toStringAsFixed(5)},${dest.lng.toStringAsFixed(5)}';

  int? _parseDurationMin(Object? duration) {
    if (duration is! String) return null;
    final seconds = int.tryParse(duration.replaceAll('s', ''));
    if (seconds == null) return null;
    return (seconds / 60).round();
  }

  List<GeoPoint> _parseEncodedPolyline(Object? polyline) {
    final encoded = polyline is Map ? polyline['encodedPolyline'] : null;
    if (encoded is! String || encoded.isEmpty) return const [];
    return [
      for (final p in decodePolyline(encoded))
        GeoPoint(p[0].toDouble(), p[1].toDouble()),
    ];
  }

  /// 出発の絶対時刻。dateOffset（isNow→0）で日付を決定する（NAVITIME 版と同基準）。
  DateTime _departureDateTime(TimeValue t) {
    final now = _clock();
    return DateTime(
      now.year,
      now.month,
      now.day,
      t.h,
      t.m,
    ).add(Duration(days: effectiveOffset(t)));
  }
}

/// 乗車駅探索・ハイブリッドの候補点。コリドー座標（停車駅 or 線路点）から作る。
/// 時刻・運賃は持たない（Transit API では取得不可・§5）。
class _CorridorStop {
  const _CorridorStop({
    required this.coord,
    required this.section,
    required this.line,
    required this.type,
  });

  final GeoPoint coord;

  /// 属する transit leg（電車・バス問わず）番号。乗換をまたぐ点は番号が異なる。
  final int section;
  final String? line;

  /// この点が属する区間種別（電車 or バス）。通常照会では train のみ。last-resort の
  /// バス候補を基準に据えたときだけ bus になる（#251）。
  final SegmentType type;

  /// ハイブリッド駅名は不明（コリドー座標に駅名は付かない）。空表示。
  String get name => '';
}
