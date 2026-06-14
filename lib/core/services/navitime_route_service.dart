import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart'; // TEMP(#B調査): フィールド計装。確認後に除去
import 'package:google_polyline_algorithm/google_polyline_algorithm.dart';
import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'hybrid_route_selector.dart';
import 'route_plan_builder.dart';
import 'route_service.dart';

/// NAVITIME route_transit（プロキシ経由）から、予算内で徒歩を最大化するルートを
/// 生成する。標準乗換経路に加え、途中駅まで歩いて乗車するハイブリッド経路を候補化する。
class NaviTimeRouteService implements RouteService {
  NaviTimeRouteService({
    http.Client? client,
    String? proxyBaseUrl,
    DateTime Function()? clock,
  }) : _client = client ?? http.Client(),
       _clock = clock ?? DateTime.now,
       _proxyBaseUrl = (proxyBaseUrl ?? AppConfig.proxyBaseUrl).replaceAll(
         RegExp(r'/+$'),
         '',
       );

  final http.Client _client;
  final String _proxyBaseUrl;
  final DateTime Function() _clock;

  /// ハイブリッド候補の乗降点に使う停車駅数の上限。候補生成は直線推定のみで
  /// Google を呼ばない（実測は採用1経路だけ）ため、これは API コストではなく
  /// 組合せ（O(駅数²)）の CPU 爆発を抑えるための上限。これを超える経路だけ
  /// 等間隔サンプリングへ縮退する。通常の経路はほぼ全停車駅を乗降点にできる。
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
    if (_proxyBaseUrl.isEmpty) throw const RouteException('NO_PROXY');
    if (origin == null) throw const RouteException('NO_ORIGIN');
    // NAVITIME route_transit / route_walk は座標が前提（地名のみは非対応）。
    if (destinationLatLng == null) {
      throw const RouteException('NO_DESTINATION');
    }
    final budgetMin = budgetMinutes(departure, arrival);

    onProgress?.call(RoutePhase.routing);

    final body = await _fetchTransit(origin, destinationLatLng, departure);
    final items = body['items'] as List<dynamic>? ?? const [];
    if (items.isEmpty) throw const RouteException('ZERO_RESULTS');

    final parsed = items
        .map((e) => _parseTransit(e as Map<String, dynamic>))
        .toList();

    onProgress?.call(RoutePhase.walkability);

    final candidates = <RouteCandidate>[
      for (final p in parsed) p.toCandidate(),
    ];

    // 全徒歩。選定フェーズの徒歩は直線距離ベースの推定（Google を呼ばない）。
    final fullWalk = _estimateWalk(
      origin,
      destinationLatLng,
      fromName: parsed.first.from,
      toName: parsed.first.to,
    );
    candidates.add(fullWalk);

    // 途中駅まで歩いて乗車するハイブリッド候補を追加する。全徒歩が直線推定で
    // 予算内でも、確定後の Google 実測で超過しうる（不具合B）。鉄道/ハイブリッド
    // との比較を打ち切らず常に候補を出し揃え、_finalize の再判定で予算内へ
    // フォールバックできるようにする。ハイブリッド構築は直線推定のみで Google を
    // 呼ばないため、全徒歩が予算内のケースでも追加コストはほぼ無い。
    final base = _baseForHybrid(parsed);
    final hybridCountBefore = candidates.length;
    if (base != null) {
      candidates.addAll(_buildHybrids(base, origin, destinationLatLng));
    }

    // TEMP(#B調査): フィールドで「ハイブリッドが生成されているか／calling_at 座標が
    // 在るか」を1回確認するための計装。不具合A が (a)二択縮退か (b)中間が疎か の
    // 切り分けに使う。確認後にこのブロックと foundation import を除去する。
    debugPrint(
      'walkmax-diag: standard=${parsed.length} '
      'callingStops=${base?.stops.length ?? 0} '
      'hybrids=${candidates.length - hybridCountBefore} '
      'fullWalkEstMin=${_estimateWalk(origin, destinationLatLng, fromName: parsed.first.from, toName: parsed.first.to).totalMin} '
      'budgetMin=$budgetMin',
    );

    return _finalize(
      candidates,
      budgetMin,
      departure,
      origin: origin,
      goal: destinationLatLng,
      onProgress: onProgress,
      fromName: originName,
      toName: destination,
    );
  }

  /// 採用経路の確定徒歩を実測（Google）後の実到着時刻で予算を再判定する試行上限。
  /// 1 試行 = 採用候補1経路の徒歩区間ぶんの Google 呼び出し。間に合う候補が在る限り
  /// 予算内へ選び直すが、Google 呼び出しを増やしすぎないよう上限で抑える。
  ///
  /// 楽観推定で予算内とした候補が実測で超過すると1段ずつ徒歩量を下げて選び直すため、
  /// 乗降点を密にした（[_maxHybridCandidates]）ぶん、実測寄りの候補へ到達するのに
  /// 必要な試行数も増える。徒歩を取りこぼさないよう、密化に合わせて上限を広げる。
  static const int _maxEnrichAttempts = 8;

  /// 乗り遅れ候補を採用しかけた際に乗車駅の時刻表を NAVITIME へ再照会する試行上限
  /// （#115）。1 試行 = 採用候補1経路ぶんの再照会1回。乗り遅れの無い経路では発生
  /// しない。実測徒歩の上書きと同様、確定しかけた候補にのみ働くため [_maxEnrichAttempts]
  /// と同等に抑えれば十分。NAVITIME コールを増やしすぎないよう上限で抑える。
  /// 注意: 上限到達後の乗り遅れ候補は再照会せず楽観時刻表のまま確定し得る（安全側の
  /// 除外ではなく楽観側へ縮退する）。実運用では候補数的に到達しない想定だが、上限は
  /// 偽陽性（乗れない列車の確定）を許す方向に効くため安易に下げないこと。
  static const int _maxRefetchAttempts = 8;

  /// 予算境界帯のマトリクス実測（#118）のパラメータ。
  ///
  /// [_minBandForMatrix]: 帯内候補がこの数未満（＝2件以下）ならマトリクスをスキップする。
  /// 要素数課金のマトリクス（2 コール）より逐次プローブの方が安いため、帯が狭いときは
  /// 実測せず逐次へ委ねる（受け入れ条件）。
  /// [_maxMatrixSideStations]: マトリクスの片側（乗車駅集合／降車駅集合）の要素上限。
  /// 要素数課金の暴発を抑えるため帯内のユニーク駅をこの数でキャップする（超過分は
  /// α 補正到着が予算に近い候補を優先）。プロキシ側の要素数上限とも整合させる。
  /// [_matrixBandDeltaMinMin]/[_matrixBandDeltaMaxMin]: 帯幅 δ（分）のクランプ下限・上限。
  static const int _minBandForMatrix = 3;
  static const int _maxMatrixSideStations = 10;
  static const int _matrixBandDeltaMinMin = 5;
  static const int _matrixBandDeltaMaxMin = 15;

  /// 候補集合から確定経路を選び RoutePlan へ。選定は直線距離ベースの推定で行うため、
  /// 表示する 1 経路ぶんの徒歩区間だけ Google Routes で街路追従ジオメトリ・所要時間・
  /// 距離に上書きする（Google 呼び出しは採用経路の徒歩区間数ぶんのみ）。
  ///
  /// 予算内と見積もった候補が実測で超過した場合は、その候補を除いて予算内の次善へ
  /// 選び直す（間に合う候補が在る限り遅刻ルートを返さない・不具合B）。元から予算内
  /// 候補が無い（best-effort）選定なら、これ以上探しても収まらないためそのまま確定する。
  ///
  /// 選定の徒歩は直線推定（楽観）で、実測（道なり）はこれを一定倍率で上回る。乗降点を
  /// 密化すると「推定内・実測超過」の徒歩寄り候補が試行上限を超えて並び、徒歩最大の
  /// 全徒歩から1段ずつ剥がす旧方式では底（間に合う鉄道）へ到達できず遅刻ルートを
  /// 返していた。そこで実測超過のたびに徒歩の道なり迂回率（実測/推定）を出発側・到着側で
  /// 別々に学習し（#117）、以降の選定で推定徒歩を側別に割増して「実測でも予算内」の
  /// 徒歩最大候補へ少ない実測で収束させる。補正は探索順（次にどれを実測するか）にのみ
  /// 効き、候補を pool から外すのは実測超過の確認時だけ（偽陰性を作らない）。確証できなければ
  /// 最長（全徒歩）ではなく実到着が最早の候補を返す（バナーの「最短を表示」と整合・不具合B）。
  Future<RoutePlan> _finalize(
    List<RouteCandidate> candidates,
    int budgetMin,
    TimeValue departure, {
    required GeoPoint origin,
    required GeoPoint goal,
    void Function(RoutePhase)? onProgress,
    String? fromName,
    String? toName,
  }) async {
    final departureAt = _departureDateTime(departure);
    final pool = [...candidates];
    // この plan() 1回のスコープで徒歩実測をレッグ単位にキャッシュする（#116）。
    // 選び直しは隣接候補で徒歩レッグの片側が一致しやすく、同じ start/goal 座標ペアへ
    // 試行回数ぶんの Google コールが重複していた。リクエストローカルに持ち回って
    // ユニークレッグ数まで実コールを抑える。失敗（null）は負キャッシュしない。
    final walkCache = <String, RouteCandidate>{};
    // 徒歩の道なり迂回率（実測/推定）を出発側（origin→駅）と到着側（駅→goal）で別々に
    // 学習する（#117）。origin 周辺と goal 周辺で街路事情（駅前グリッド vs 河川・線路
    // 分断など）が異なるため、単一値より側別の方が実測に当たりやすい。実測超過のたびに
    // 該当側を更新し、選定（探索順）の徒歩推定割増にだけ使う（除外は実測のみ）。
    var originDetour = 1.0;
    var goalDetour = 1.0;
    // 乗り遅れ再照会の実行回数（[_maxRefetchAttempts] で上限管理する）。
    var refetches = 0;
    // 予算境界帯のレッグをマトリクスで一括実測した値（分）をレッグキー単位で持つ（#118）。
    // 選定（探索順・予算判定）でのみ参照し、α 割増（推定）より優先する。採用経路の表示値・
    // ジオメトリは従来どおり _enrichWalkGeometry（computeRoutes）で取り直すため、ここには
    // 格納しない（マトリクスは polyline を返さず、表示は computeRoutes 値で統一する）。
    final measuredLegs = <String, int>{};
    // マトリクス実測は1回の plan() で一度だけ試みる（帯は α 学習後に確定するため）。
    var matrixMeasured = false;

    for (
      var attempt = 0;
      attempt < _maxEnrichAttempts && pool.isNotEmpty;
      attempt++
    ) {
      // 学習済みの側別迂回率・マトリクス実測で徒歩推定を補正した候補で選定する
      // （実測に近い土俵で比較）。
      final scaled =
          (originDetour > 1.0 || goalDetour > 1.0 || measuredLegs.isNotEmpty)
          ? [
              for (final c in pool)
                _inflateWalk(c, originDetour, goalDetour, measuredLegs),
            ]
          : pool;
      final picked = selectBestRoute(
        candidates: scaled,
        budgetMin: budgetMin,
        origin: origin,
        goal: goal,
        departureAt: departureAt,
      );
      final pick = pool[scaled.indexOf(picked)];
      // 楽観（未補正）推定での予算内可否。偽＝最善でも入らない best-effort で、
      // これ以上探しても収まらないため即確定する（無駄な実測を避ける）。
      final withinByEstimate =
          arrivalMinutes(pick.segments, departureAt) <= budgetMin;
      var enriched = await _enrichWalkGeometry(pick, walkCache);

      // 確定しかけ（推定・実測徒歩ともに予算内）の候補が予定列車に乗り遅れるなら、
      // 乗車駅からの時刻表を NAVITIME へ再照会し、実在列車の発着で当該区間を差し替えて
      // 実到着を再判定する（#115）。乗り遅れの無い経路や best-effort（!withinByEstimate）
      // では再照会しない。再照会で実在列車を確認できなければ遅刻列車を確定せず除外する。
      if (withinByEstimate &&
          refetches < _maxRefetchAttempts &&
          arrivalMinutes(enriched.segments, departureAt) <= budgetMin) {
        final missed = firstMissedTrain(enriched.segments, departureAt);
        if (missed != null) {
          refetches++;
          final real = await _refetchMissedTrain(
            enriched,
            missed,
            goal,
            departureAt,
          );
          if (real == null) {
            // 実在の後続列車を確認できない → 当該候補を除外して次善へ。
            pool.remove(pick);
            continue;
          }
          enriched = real;
        }
      }

      final withinByActual =
          arrivalMinutes(enriched.segments, departureAt) <= budgetMin;
      if (withinByActual) {
        return _build(
          enriched,
          departure,
          budgetMin,
          onProgress,
          fromName: fromName,
          toName: toName,
        );
      }
      // 最善でも予算内に届かない best-effort（!withinByEstimate）。ここで pool ローカルの
      // pick を即返すと、実測超過で pool から外れた全徒歩を見落とし「今夜乗れない」翌朝
      // 電車を返してしまう。ループ末尾の縮退（全 candidates ＋乗車待ちフィルタ）へ委ねて
      // 全徒歩を含めて選び直す（#121 原因②）。
      if (!withinByEstimate) break;
      // 予算内見積もりが実測（徒歩の道なり迂回・再照会した実在列車の待ち）で超過
      // → 側別の迂回率を学習し、その候補を除いて選び直す。
      final learned = _learnDetours(originDetour, goalDetour, pick, enriched);
      originDetour = learned.origin;
      goalDetour = learned.goal;
      pool.remove(pick);

      // 初回の実測超過で α を学習した直後に、予算境界帯の候補レッグをマトリクスで
      // 一括実測する（#118）。逐次プローブは α 補正が外れると真のフロンティア候補を
      // 試す前に上限へ達し得るが、帯内を実測値で正確に比較すれば「α では後回しだが
      // 実測では徒歩最大」の候補も拾える。実測値は measuredLegs に入り、以降の選定が
      // 透過的に使う。帯内候補2件以下・マトリクス失敗時は何もせず逐次プローブへ委ねる。
      if (!matrixMeasured) {
        matrixMeasured = true;
        await _measureFrontierBand(
          pool,
          budgetMin,
          departureAt,
          origin,
          goal,
          originDetour,
          goalDetour,
          measuredLegs,
        );
      }
    }

    // 予算内を確証できず → 実到着が最早の候補を best-effort で返す（遅刻時に
    // 最長＝全徒歩を返さず、バナーの「最短を表示」と整合させる）。ただし乗車待ちが
    // 予算を超える「今夜乗れない」電車（終電後の翌朝始発など）は後回しにし、乗車待ちが
    // 予算内の候補（全徒歩を含む）を優先する（#121 原因②）。
    final fallbackPool =
        reachableWithinBudget(candidates, budgetMin, departureAt) ?? candidates;
    final shortest = fallbackPool.reduce(
      (a, b) =>
          arrivalMinutes(a.segments, departureAt) <=
              arrivalMinutes(b.segments, departureAt)
          ? a
          : b,
    );
    return _build(
      await _enrichWalkGeometry(shortest, walkCache),
      departure,
      budgetMin,
      onProgress,
      fromName: fromName,
      toName: toName,
    );
  }

  /// 候補 [c] の徒歩区間の所要分を、選定（予算判定・探索順）用に補正したコピーにする。
  /// 各徒歩レッグについて、マトリクスで実測済み（[measured] に polyline 端点キーが在る）
  /// なら実測分を優先し、無ければ側別の道なり迂回率で割増する（#117）：出発側（最初の
  /// 電車より前）は [originDetour]・到着側（電車以降の乗換／降車徒歩）は [goalDetour]。
  /// 実測（#118）はマトリクスで帯内レッグを正確に測った値で、α 割増（推定）より優先する
  /// ことで「α では2番手だが実測では徒歩最大」の候補も正しく拾える。電車区間はそのまま。
  /// 実測ジオメトリは polyline 端点から取り直すため、ここで距離・kcal は触らず所要分だけ
  /// 補正すれば選定には十分。電車を含まない全徒歩候補は出発側係数で割増する——探索順の
  /// 補正のみで除外には使わないため片側係数で十分（偽陰性を作らない）。
  RouteCandidate _inflateWalk(
    RouteCandidate c,
    double originDetour,
    double goalDetour,
    Map<String, int> measured,
  ) {
    var seenTrain = false;
    final segments = <RouteSegment>[];
    for (final s in c.segments) {
      if (s.type == SegmentType.train) {
        seenTrain = true;
        segments.add(s);
        continue;
      }
      if (s.type != SegmentType.walk) {
        segments.add(s);
        continue;
      }
      final measuredMin = s.polyline.length >= 2
          ? measured[_walkCacheKey(s.polyline.first, s.polyline.last)]
          : null;
      final detour = seenTrain ? goalDetour : originDetour;
      segments.add(
        RouteSegment(
          type: s.type,
          fromName: s.fromName,
          toName: s.toName,
          minutes: measuredMin ?? (s.minutes * detour).round(),
          km: s.km,
          kcal: s.kcal,
          line: s.line,
          fare: s.fare,
          stops: s.stops,
          polyline: s.polyline,
          depTime: s.depTime,
          arrTime: s.arrTime,
        ),
      );
    }
    return RouteCandidate(from: c.from, to: c.to, segments: segments);
  }

  /// 実測超過した候補の徒歩区間から、出発側・到着側それぞれの道なり迂回率を学習する
  /// （#117）。推定 [estimate] と実測 [actual] は同順・同数の区間で、徒歩区間ごとに
  /// `ratio = 実測分 / 推定分` を求め、最初の電車より前を出発側・電車以降を到着側へ
  /// 振り分けて学習する。各側とも現値 [currentOrigin]/[currentGoal] および同側の複数
  /// レッグと比べ大きい方を採り、反復をまたいで単調に締める（旧単一値 `_learnDetour` の
  /// 単調性を側別へ引き継ぐ）。本値は選定の探索順割増にのみ使い除外には使わないため、
  /// 過小割増（実測失敗で1試行を浪費）より過大寄りの方が少ない実測で収束する。クランプ
  /// α∈[1.0,2.0] で、実測が推定を下回る異常値（< 1.0）や外れ値（> 2.0）の暴走を抑える。
  ///
  /// 電車を含まない全徒歩候補は origin→goal の両街路を横断する単一レッグで、どちらか一方
  /// の側に帰属できない。その混合迂回率を片側（や両側）へ写すと素直な側を過大評価して
  /// しまうため、側別学習には用いない（駅で区切られたレッグのみが各側を素直に表す）。
  /// 学習できる徒歩が無ければ現値 [currentOrigin]/[currentGoal] を保つ。
  ({double origin, double goal}) _learnDetours(
    double currentOrigin,
    double currentGoal,
    RouteCandidate estimate,
    RouteCandidate actual,
  ) {
    final hasTrain = estimate.segments.any((s) => s.type == SegmentType.train);
    if (!hasTrain) return (origin: currentOrigin, goal: currentGoal);

    double? originRatio;
    double? goalRatio;
    var seenTrain = false;
    for (var i = 0; i < estimate.segments.length; i++) {
      final es = estimate.segments[i];
      if (es.type == SegmentType.train) {
        seenTrain = true;
        continue;
      }
      if (es.type != SegmentType.walk || es.minutes <= 0) continue;
      final ratio = (actual.segments[i].minutes / es.minutes).clamp(1.0, 2.0);
      if (seenTrain) {
        goalRatio = goalRatio == null ? ratio : math.max(goalRatio, ratio);
      } else {
        originRatio = originRatio == null
            ? ratio
            : math.max(originRatio, ratio);
      }
    }
    return (
      origin: originRatio == null
          ? currentOrigin
          : math.max(originRatio, currentOrigin),
      goal: goalRatio == null ? currentGoal : math.max(goalRatio, currentGoal),
    );
  }

  /// 予算境界帯（フロンティア帯）の候補レッグを computeRouteMatrix で一括実測し、
  /// 実測分を [measured] へレッグキー単位で格納する（#118）。
  ///
  /// 帯は α 補正到着が `予算 − δ ≤ 到着 ≤ 予算 + δ` の候補。δ は α の不確かさ由来で、
  /// 側別迂回率の差（[originDetour]−[goalDetour] の幅）× 帯の代表徒歩推定分を
  /// [_matrixBandDeltaMinMin]〜[_matrixBandDeltaMaxMin] でクランプする。帯内候補が
  /// [_minBandForMatrix] 未満なら逐次プローブの方が安いため実測しない。帯内のユニーク
  /// 乗車駅（origin→駅）・降車駅（駅→goal）を片側 [_maxMatrixSideStations] でキャップ
  /// （超過分は α 補正到着が予算に近い候補を優先）し、2 回のマトリクスコールで実測する。
  /// マトリクスは polyline を返さないため [measured] には所要分のみ入り、選定（探索順・
  /// 予算判定）でのみ使う。出発側・到着側のコールは独立で、片側が失敗してもその側だけ
  /// 未実測のまま他方は反映する（未実測のレッグは逐次プローブが補う）。
  Future<void> _measureFrontierBand(
    List<RouteCandidate> pool,
    int budgetMin,
    DateTime departureAt,
    GeoPoint origin,
    GeoPoint goal,
    double originDetour,
    double goalDetour,
    Map<String, int> measured,
  ) async {
    if (pool.isEmpty) return;

    // 帯幅 δ。側別迂回率の差を α の不確かさとみなし、帯の代表徒歩推定分（pool 内の
    // 最大徒歩推定）に掛けてクランプする。差が無くても下限分だけは帯を取る。
    final spread =
        math.max(originDetour, goalDetour) - math.min(originDetour, goalDetour);
    final maxWalkEst = pool.fold<int>(0, (m, c) => math.max(m, c.walkMinutes));
    final delta = (spread * maxWalkEst).round().clamp(
      _matrixBandDeltaMinMin,
      _matrixBandDeltaMaxMin,
    );

    // α 補正到着（マトリクス未反映の純 α 割増）を候補ごとに一度だけ算出する。
    // 帯の切り出し・予算近接ソートで何度も参照するため、_inflateWalk の再生成を
    // 避けてここでメモ化する。
    final corrected = <RouteCandidate, int>{
      for (final c in pool)
        c: arrivalMinutes(
          _inflateWalk(c, originDetour, goalDetour, const {}).segments,
          departureAt,
        ),
    };
    final band = pool.where((c) {
      final a = corrected[c]!;
      return budgetMin - delta <= a && a <= budgetMin + delta;
    }).toList();
    if (band.length < _minBandForMatrix) return;

    // 帯内を予算近接順に並べ、片側上限まで乗車駅（origin→駅）・降車駅（駅→goal）を集める。
    band.sort(
      (x, y) => (corrected[x]! - budgetMin).abs().compareTo(
        (corrected[y]! - budgetMin).abs(),
      ),
    );
    final boards = <String, GeoPoint>{};
    final alights = <String, GeoPoint>{};
    for (final c in band) {
      for (final s in c.segments) {
        if (s.type != SegmentType.walk || s.polyline.length < 2) continue;
        if (_sameCoord(s.polyline.first, origin)) {
          final dest = s.polyline.last;
          final key = _walkCacheKey(origin, dest);
          if (!boards.containsKey(key) &&
              boards.length < _maxMatrixSideStations) {
            boards[key] = dest;
          }
        }
        if (_sameCoord(s.polyline.last, goal)) {
          final src = s.polyline.first;
          final key = _walkCacheKey(src, goal);
          if (!alights.containsKey(key) &&
              alights.length < _maxMatrixSideStations) {
            alights[key] = src;
          }
        }
      }
    }

    // 出発側レッグ（origin→各乗車駅）を1コールで実測。出発側・到着側は独立に試み、
    // 片側が失敗（null）しても他方は実測する（その側のレッグは逐次プローブが補う）。
    if (boards.isNotEmpty) {
      final dests = boards.values.toList();
      final rows = await _fetchWalkMatrix([origin], dests);
      if (rows != null) {
        for (final e in rows) {
          if (e is! Map) continue;
          final di = (e['destinationIndex'] as num?)?.toInt() ?? 0;
          final min = _parseDurationMin(e['duration']);
          if (min == null || di < 0 || di >= dests.length) continue;
          measured[_walkCacheKey(origin, dests[di])] = min;
        }
      }
    }
    // 到着側レッグ（各降車駅→goal）を1コールで実測。
    if (alights.isNotEmpty) {
      final srcs = alights.values.toList();
      final rows = await _fetchWalkMatrix(srcs, [goal]);
      if (rows != null) {
        for (final e in rows) {
          if (e is! Map) continue;
          final oi = (e['originIndex'] as num?)?.toInt() ?? 0;
          final min = _parseDurationMin(e['duration']);
          if (min == null || oi < 0 || oi >= srcs.length) continue;
          measured[_walkCacheKey(srcs[oi], goal)] = min;
        }
      }
    }
  }

  /// computeRouteMatrix（徒歩）をプロキシ経由で叩き、要素配列を返す（#118）。
  /// origins/destinations はセミコロン区切りの "lat,lng" 列。失敗（HTTP 異常・
  /// 配列でない応答・通信失敗）は null（呼び出し側が逐次プローブへフォールバック）。
  Future<List<dynamic>?> _fetchWalkMatrix(
    List<GeoPoint> origins,
    List<GeoPoint> dests,
  ) async {
    String join(List<GeoPoint> ps) =>
        ps.map((p) => '${p.lat},${p.lng}').join(';');
    try {
      return await _fetchArray('googleWalkMatrixProxy', {
        'origins': join(origins),
        'destinations': join(dests),
      });
    } on RouteException {
      return null;
    }
  }

  /// 座標が（キャッシュキーと同じ小数5桁丸めで）一致するか。レッグの端点が origin/goal に
  /// 等しいか判定し、出発側／到着側レッグを見分けるのに使う。
  bool _sameCoord(GeoPoint a, GeoPoint b) =>
      a.lat.toStringAsFixed(5) == b.lat.toStringAsFixed(5) &&
      a.lng.toStringAsFixed(5) == b.lng.toStringAsFixed(5);

  /// 確定経路の徒歩区間を Google Routes の街路ジオメトリ・所要時間・距離で
  /// 上書きする。標準乗換候補の徒歩は NAVITIME 由来（shape 無し→端点直線）の
  /// ため、区間端点（polyline の両端）を start/goal に再取得して街路追従へそろえる。
  /// 取得失敗時は元の直線を保つ（線を欠落させない）。座標を持たない区間は対象外。
  Future<RouteCandidate> _enrichWalkGeometry(
    RouteCandidate chosen,
    Map<String, RouteCandidate> cache,
  ) async {
    final segments = <RouteSegment>[];
    for (final seg in chosen.segments) {
      if (seg.type != SegmentType.walk || seg.polyline.length < 2) {
        segments.add(seg);
        continue;
      }
      final walk = await _tryWalk(
        seg.polyline.first,
        seg.polyline.last,
        fromName: seg.fromName,
        toName: seg.toName,
        cache: cache,
      );
      segments.add(walk?.segments.first ?? seg);
    }
    return RouteCandidate(from: chosen.from, to: chosen.to, segments: segments);
  }

  /// 確定しかけた候補 [enriched] の乗り遅れ電車区間 [missed] を、乗車駅からの時刻表を
  /// NAVITIME に再照会して実在列車の発着時刻へ差し替える（#115）。乗車駅座標は当該
  /// 区間 polyline の先頭、再照会の出発時刻は出発 [departureAt] + 駅着までの実累積分。
  /// 同一路線・同一降車駅を含み、駅着以降に発車する実在列車が見つかればその dep/arr で
  /// 区間を差し替えた候補を返す。見つからなければ null（呼び出し側が候補を除外し次善へ）。
  /// 運賃・距離・polyline・停車数は元の按分値を保ち、発着時刻と乗車時間だけ実データへ。
  Future<RouteCandidate?> _refetchMissedTrain(
    RouteCandidate enriched,
    ({int index, int cumBefore}) missed,
    GeoPoint goal,
    DateTime departureAt,
  ) async {
    final train = enriched.segments[missed.index];
    if (train.polyline.isEmpty) return null;
    final board = train.polyline.first;
    final startTime = departureAt.add(Duration(minutes: missed.cumBefore));

    final Map<String, dynamic> body;
    try {
      body = await _fetchTransitAt(board, goal, startTime);
    } on RouteException {
      return null;
    }
    final items = (body['items'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
    final real = _findRealBoarding(
      items,
      line: train.line,
      boardName: train.fromName,
      alightName: train.toName,
      notBefore: startTime,
    );
    if (real == null) return null;
    final ride = _minutesBetween(real.arr, real.dep);
    if (ride < 0) return null;

    final replaced = RouteSegment(
      type: SegmentType.train,
      fromName: train.fromName,
      toName: train.toName,
      minutes: ride,
      km: train.km,
      line: train.line,
      fare: train.fare,
      stops: train.stops,
      polyline: train.polyline,
      depTime: real.dep,
      arrTime: real.arr,
    );
    final segments = [
      for (var i = 0; i < enriched.segments.length; i++)
        if (i == missed.index) replaced else enriched.segments[i],
    ];
    // 多区間経路で最初の乗り遅れ区間を遅い実在列車へ差し替えると、再照会していない
    // 下流の電車区間が借用時刻表のまま乗り遅れ（接続崩れ）になり得る。その場合は
    // 楽観評価（_advance の待ち0・同乗車時間近似）で下流を確定しないよう候補ごと
    // 除外し、呼び出し側の次善フォールバックに委ねる（乗れない列車を確定しない）。
    // ハイブリッドは単一電車のためここは常に null（差し替え1区間で完結する）。
    if (firstMissedTrain(segments, departureAt) != null) return null;
    return RouteCandidate(
      from: enriched.from,
      to: enriched.to,
      segments: segments,
    );
  }

  /// 再照会レスポンス [items] から、乗車駅 [boardName]（同一路線 [line]）を [notBefore]
  /// 以降に発車し、同一乗車区間内で降車駅 [alightName] に停車する実在列車の発着時刻を
  /// 探す。MVP は別路線・別降車駅の経路を採らず、見つからなければ null（候補を除外）。
  /// [notBefore] より前に発車する列車（＝駅着前に出てしまい乗れない）は除外する。
  /// [items] は route_transit が最早接続を先頭に返す前提で、最初に条件を満たした列車を
  /// 採る（dep でソートし直さない）。順序が崩れると最早でない列車を拾い不要な
  /// フォールバックを招き得るが、乗れない列車は確定しないため正確性は保たれる。
  ({DateTime dep, DateTime arr})? _findRealBoarding(
    List<Map<String, dynamic>> items, {
    required String? line,
    required String boardName,
    required String alightName,
    required DateTime notBefore,
  }) {
    for (final item in items) {
      final stops = _parseTransit(item).stops;
      for (var b = 0; b < stops.length; b++) {
        final boarding = stops[b];
        if (boarding.name != boardName || boarding.dep == null) continue;
        if (line != null && boarding.line != line) continue;
        if (boarding.dep!.isBefore(notBefore)) continue;
        for (var a = b + 1; a < stops.length; a++) {
          final alighting = stops[a];
          // 同一乗車区間を外れたら（乗換）この乗車では a へ行けない。
          if (alighting.section != boarding.section) break;
          if (alighting.name == alightName && alighting.arr != null) {
            return (dep: boarding.dep!, arr: alighting.arr!);
          }
        }
      }
    }
    return null;
  }

  RoutePlan _build(
    RouteCandidate chosen,
    TimeValue departure,
    int budgetMin,
    void Function(RoutePhase)? onProgress, {
    String? fromName,
    String? toName,
  }) {
    onProgress?.call(RoutePhase.building);
    return buildRoutePlan(
      // アプリが持つ実際の出発地・目的地名を優先する。NAVITIME は座標問い合わせ
      // だと地点名を "start"/"goal" で返すため、解析値はフォールバックに留める。
      from: _displayName(fromName, chosen.from),
      to: _displayName(toName, chosen.to),
      segments: chosen.segments,
      departure: departure,
      budgetMin: budgetMin,
      departureAt: _departureDateTime(departure),
    );
  }

  /// 表示名を決める。アプリ由来の [override] が空でなければそれを、無ければ
  /// NAVITIME 解析値 [fallback] を使う。
  String _displayName(String? override, String fallback) {
    final name = override?.trim();
    return (name != null && name.isNotEmpty) ? name : fallback;
  }

  /// 停車駅タイムラインを持つ最短の標準経路をハイブリッドの基準にする。
  _TransitParse? _baseForHybrid(List<_TransitParse> parsed) {
    _TransitParse? best;
    for (final p in parsed) {
      if (p.stops.length < 2) continue;
      if (best == null || p.totalMin < best.totalMin) best = p;
    }
    return best;
  }

  /// 基準経路の停車駅から「乗車駅 b → 降車駅 a（b より後方）」の全分割を候補化する。
  /// 各駅の origin→駅 / 駅→goal 徒歩は直線距離ベースで推定（Google を呼ばない）し、
  /// 乗車時間は [_rideMinutes]（時刻表の差、無ければ距離から概算）で求める。
  /// これにより乗車を後ろ倒し（徒歩を増やす）したり、
  /// 手前で降りて目的地まで歩く候補が同じ土俵に並ぶ。生成する候補は
  /// [_maxHybridCandidates] 駅のサンプルで組合せ爆発を抑える。
  List<RouteCandidate> _buildHybrids(
    _TransitParse base,
    GeoPoint origin,
    GeoPoint goal,
  ) {
    final stops = base.stops;
    final indices = _sampleIndices(stops.length, _maxHybridCandidates);

    // 各停車駅の origin→駅 / 駅→goal 徒歩を直線距離から推定する。
    final fromOrigin = <int, RouteSegment>{
      for (final i in indices)
        i: _estimateWalk(
          origin,
          stops[i].coord,
          fromName: base.from,
          toName: stops[i].name,
        ).segments.first,
    };
    final toGoal = <int, RouteSegment>{
      for (final i in indices)
        i: _estimateWalk(
          stops[i].coord,
          goal,
          fromName: stops[i].name,
          toName: base.to,
        ).segments.first,
    };

    final result = <RouteCandidate>[];
    for (final b in indices) {
      final walk1 = fromOrigin[b]!;
      for (final a in indices) {
        if (a <= b) continue;
        // 乗換をまたぐ b→a は単一乗車として表現できない（路線・乗換・運賃を
        // 誤る）ため、同一乗車区間内のペアのみ候補化する。
        if (stops[a].section != stops[b].section) continue;
        final walk2 = toGoal[a]!;
        final ride = _rideMinutes(stops, b, a);
        if (ride < 0) continue;
        final rideKm = _railKm(stops, b, a);
        final segments = <RouteSegment>[
          if (walk1.minutes > 0) walk1,
          RouteSegment(
            type: SegmentType.train,
            fromName: stops[b].name,
            toName: stops[a].name,
            minutes: ride,
            km: rideKm,
            line: stops[b].line,
            fare: _proratedFare(stops, b, a, rideKm),
            stops: a - b,
            // 時刻表が揃えば乗車駅 dep・降車駅 arr の絶対時刻を持たせる（#65）。
            depTime: stops[b].dep,
            arrTime: stops[a].arr,
            // 乗車区間 b→a の停車駅座標を折れ線にする（shape 代替）。
            polyline: [for (var i = b; i <= a; i++) stops[i].coord],
          ),
          if (walk2.minutes > 0) walk2,
        ];
        result.add(
          RouteCandidate(from: base.from, to: base.to, segments: segments),
        );
      }
    }
    return result;
  }

  /// 乗車区間 [b]→[a] の所要時間（分）。両端の発着時刻が揃えば時刻表の差を使い、
  /// どちらかが欠落していれば停車駅折れ線長を [trainMetersPerMinute] で割って概算する
  /// （calling_at の時刻欠落でハイブリッドを取りこぼさないため #67）。
  int _rideMinutes(List<_Stop> stops, int b, int a) {
    final dep = stops[b].dep;
    final arr = stops[a].arr;
    if (dep != null && arr != null) return _minutesBetween(arr, dep);
    return (_railKm(stops, b, a) * 1000 / trainMetersPerMinute).round();
  }

  /// 乗車区間 [b]→[a]（同一区間・連続インデックス）の距離概算。途中停車駅を
  /// 結ぶ折れ線長で、始終点の直線距離より実鉄道距離に近い値を返す。
  double _railKm(List<_Stop> stops, int b, int a) {
    var km = 0.0;
    for (var i = b; i < a; i++) {
      km += haversineKm(stops[i].coord, stops[i + 1].coord);
    }
    return km;
  }

  /// ハイブリッド乗車区間 [b]→[a]（鉄道距離 [rideKm]）の運賃。セクション全体の
  /// 運賃を、乗車区間の鉄道距離 ÷ セクション全体の鉄道距離で按分する（途中駅から
  /// 短く乗る場合に全区間運賃をそのまま使うと過大になるため #71）。運賃が取得
  /// できない区間やセクション距離が 0 の場合はセクション運賃をそのまま返す（null
  /// も許容）。同一 section は stops 配列上で連続している前提で前後に拡張する。
  int? _proratedFare(List<_Stop> stops, int b, int a, double rideKm) {
    final fare = stops[b].fare;
    if (fare == null) return null;
    final section = stops[b].section;
    var first = b;
    var last = a;
    while (first > 0 && stops[first - 1].section == section) {
      first--;
    }
    while (last < stops.length - 1 && stops[last + 1].section == section) {
      last++;
    }
    final fullKm = _railKm(stops, first, last);
    if (fullKm <= 0) return fare;
    return (fare * rideKm / fullKm).round();
  }

  /// [n] 個の停車駅から最大 [cap] 個を等間隔に抽出する（両端を含む）。
  List<int> _sampleIndices(int n, int cap) {
    if (n <= cap) return [for (var i = 0; i < n; i++) i];
    final out = <int>{};
    for (var k = 0; k < cap; k++) {
      out.add((k * (n - 1) / (cap - 1)).round());
    }
    return out.toList()..sort();
  }

  Future<Map<String, dynamic>> _fetchTransit(
    GeoPoint origin,
    GeoPoint goal,
    TimeValue departure,
  ) => _fetchTransitAt(origin, goal, _departureDateTime(departure));

  /// 乗車駅などの絶対時刻 [startTime] を起点に route_transit を引く（乗り遅れ再照会
  /// #115 と通常照会の共通経路）。クエリは [_fetchTransit] と同形で start_time だけ
  /// 任意の絶対時刻に差し替える。
  Future<Map<String, dynamic>> _fetchTransitAt(
    GeoPoint start,
    GeoPoint goal,
    DateTime startTime,
  ) => _fetch('navitimeProxy', {
    'start': '${start.lat},${start.lng}',
    'goal': '${goal.lat},${goal.lng}',
    'start_time': _formatStartTime(startTime),
    'options': 'railway_calling_at',
    'shape': 'true',
  });

  /// origin→dest を直線距離から推定した徒歩区間候補にする（API 呼び出しなし）。
  /// 候補選定フェーズ用。確定経路に選ばれれば [_enrichWalkGeometry] が Google の
  /// 街路追従ジオメトリ・所要時間・距離へ上書きする。polyline は端点直線。
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

  /// origin→dest の徒歩を Google Routes API（computeRoutes, travelMode=WALK,
  /// プロキシ経由）で取得して単一の徒歩区間候補にする。NAVITIME は徒歩 shape を
  /// 返さないため、街路追従ジオメトリは Google から得る。所要時間・距離も同一
  /// レスポンスから取り、徒歩区間の値を Google に統一する。
  /// 失敗時は null（標準経路へ縮退）。
  Future<RouteCandidate?> _tryWalk(
    GeoPoint origin,
    GeoPoint dest, {
    required String fromName,
    required String toName,
    Map<String, RouteCandidate>? cache,
  }) async {
    // レッグ単位キャッシュ（#116）。座標を 5 桁（≒1.1m）に丸めた文字列キーで引く。
    // ヒット時は実測ジオメトリ・所要・距離を再利用しつつ、表示名は要求側（候補側）の
    // fromName/toName へ差し替える（同一座標でも候補により表示名は異なり得る）。
    if (cache != null) {
      final key = _walkCacheKey(origin, dest);
      final hit = cache[key];
      if (hit != null) return _renameWalk(hit, fromName, toName);
    }
    try {
      final body = await _fetch('googleWalkProxy', {
        'start': '${origin.lat},${origin.lng}',
        'goal': '${dest.lat},${dest.lng}',
      });
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
            // polyline が無ければ origin→dest を直線で結ぶ。
            polyline: shape.isNotEmpty ? shape : [origin, dest],
          ),
        ],
      );
      // 実測成功のみキャッシュ。失敗（下の null 返却）は負キャッシュしないため、
      // 一時的なネットワーク失敗が検索全体へ波及しない（同一レッグは再試行され得る）。
      if (cache != null) cache[_walkCacheKey(origin, dest)] = result;
      return result;
    } on RouteException {
      return null;
    }
  }

  /// 徒歩実測キャッシュのキー。座標の浮動小数同値性に依存しないよう小数5桁
  /// （≒1.1m 精度）へ丸めた start|goal 文字列にする。
  String _walkCacheKey(GeoPoint origin, GeoPoint dest) =>
      '${origin.lat.toStringAsFixed(5)},${origin.lng.toStringAsFixed(5)}'
      '|${dest.lat.toStringAsFixed(5)},${dest.lng.toStringAsFixed(5)}';

  /// キャッシュ済み徒歩区間 [cached] を、要求側の表示名 [fromName]/[toName] で
  /// 差し替えた候補にする。実測値（所要・距離・kcal・polyline）はそのまま再利用する。
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

  /// Google Routes の duration（"123s" 形式の文字列）を分へ丸める。
  int? _parseDurationMin(Object? duration) {
    if (duration is! String) return null;
    final seconds = int.tryParse(duration.replaceAll('s', ''));
    if (seconds == null) return null;
    return (seconds / 60).round();
  }

  /// Google Routes の polyline.encodedPolyline をデコードして座標列にする。
  /// decodePolyline は [lat, lng] 順のペアを返す。
  List<GeoPoint> _parseEncodedPolyline(Object? polyline) {
    final encoded = polyline is Map ? polyline['encodedPolyline'] : null;
    if (encoded is! String || encoded.isEmpty) return const [];
    return [
      for (final p in decodePolyline(encoded))
        GeoPoint(p[0].toDouble(), p[1].toDouble()),
    ];
  }

  Future<Map<String, dynamic>> _fetch(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw RouteException('HTTP ${res.statusCode}');
    }
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  /// JSON 配列を返すエンドポイント（computeRouteMatrix プロキシ #118）用の取得。
  /// 200 以外・配列でない応答は [RouteException]（呼び出し側でフォールバック）。
  Future<List<dynamic>> _fetchArray(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw RouteException('HTTP ${res.statusCode}');
    }
    final decoded = jsonDecode(utf8.decode(res.bodyBytes));
    if (decoded is! List) throw const RouteException('MATRIX_NOT_ARRAY');
    return decoded;
  }

  _TransitParse _parseTransit(Map<String, dynamic> item) {
    final sections = (item['sections'] as List<dynamic>)
        .cast<Map<String, dynamic>>();
    final points = sections.where((s) => s['type'] == 'point').toList();
    final from = points.isNotEmpty
        ? (points.first['name'] as String? ?? '出発地')
        : '出発地';
    final to = points.isNotEmpty
        ? (points.last['name'] as String? ?? '目的地')
        : '目的地';

    String nameAt(int i) => sections[i]['name'] as String? ?? '';

    final segments = <RouteSegment>[];
    final stops = <_Stop>[];
    var trainSection = 0;

    for (var i = 0; i < sections.length; i++) {
      final sec = sections[i];
      if (sec['type'] != 'move') continue;
      final meters = (sec['distance'] as num?)?.toInt() ?? 0;
      final minutes = (sec['time'] as num?)?.toInt() ?? 0;
      final km = meters / 1000.0;
      final fromName = i > 0 ? nameAt(i - 1) : from;
      final toName = i + 1 < sections.length ? nameAt(i + 1) : to;

      // shape（街路追従ジオメトリ）が無い場合に備え、前後の point 座標を控える。
      final prevCoord = i > 0 ? _coordOf(sections[i - 1]) : null;
      final nextCoord = i + 1 < sections.length
          ? _coordOf(sections[i + 1])
          : null;
      final shape = _parseShape(sec);

      if (sec['move'] == 'walk') {
        segments.add(
          RouteSegment(
            type: SegmentType.walk,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            kcal: (km * kcalPerKm).round(),
            // shape が無ければ区間端点を直線で結ぶ。
            polyline: shape.isNotEmpty
                ? shape
                : _lineFrom([prevCoord, nextCoord]),
          ),
        );
      } else {
        final line = sec['line_name'] as String?;
        final sectionStops = _parseCalling(sec, line, trainSection);
        stops.addAll(sectionStops);
        trainSection++;
        // shape が無ければ停車駅(calling_at)座標、それも無ければ端点で代替。
        final calling = _callingCoords(sec);
        // 時刻表が揃えば乗車（始駅 dep）・降車（終駅 arr）の絶対時刻を持たせ、
        // タイムラインの乗車前・乗換待ちを反映する（#65）。
        segments.add(
          RouteSegment(
            type: SegmentType.train,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            line: line,
            stops: (sec['stop_count'] as num?)?.toInt(),
            fare: _fareOf(sec),
            depTime: sectionStops.isNotEmpty ? sectionStops.first.dep : null,
            arrTime: sectionStops.isNotEmpty ? sectionStops.last.arr : null,
            polyline: shape.isNotEmpty
                ? shape
                : (calling.length >= 2
                      ? calling
                      : _lineFrom([prevCoord, nextCoord])),
          ),
        );
      }
    }

    return _TransitParse(from: from, to: to, segments: segments, stops: stops);
  }

  /// 電車区間の停車駅（座標を持つもの）を順序通りに取得する。発着時刻は欠落しても
  /// 座標があれば残す（プロキシ/RapidAPI 由来データは時刻が欠けることがあり、それで
  /// 停車駅を捨てるとハイブリッド候補が生成されず予算が余る #67 の再発要因になる）。
  /// 時刻が無い区間の乗車時間は [_rideMinutes] が距離から概算する。
  /// [line] はその区間から乗車する際の路線名、[section] は乗車区間の通し番号
  /// （乗換をまたぐペアを除外するために用いる）。
  List<_Stop> _parseCalling(
    Map<String, dynamic> trainSec,
    String? line,
    int section,
  ) {
    final transport = trainSec['transport'];
    final raw =
        (transport is Map ? transport['calling_at'] : null) ??
        trainSec['calling_at'];
    if (raw is! List) return const [];

    // セクション運賃は全停車駅で共通。ハイブリッドの距離按分の基準にする。
    final sectionFare = _fareOf(trainSec);
    final out = <_Stop>[];
    for (final e in raw) {
      if (e is! Map) continue;
      final coord = e['coord'];
      final lat = coord is Map ? (coord['lat'] as num?)?.toDouble() : null;
      final lon = coord is Map
          ? ((coord['lon'] as num?) ?? (coord['lng'] as num?))?.toDouble()
          : null;
      if (lat == null || lon == null) continue;
      out.add(
        _Stop(
          name: e['name'] as String? ?? '',
          coord: GeoPoint(lat, lon),
          arr: parseNavitimeJst(e['from_time'] as String?),
          dep: parseNavitimeJst(e['to_time'] as String?),
          line: line,
          section: section,
          fare: sectionFare,
        ),
      );
    }
    return out;
  }

  /// move セクションの shape（GeoJSON LineString）を座標列へ変換する。
  /// NAVITIME は coordinates を [lng, lat] 順で返す。未知形状は空（地図線なし）。
  List<GeoPoint> _parseShape(Map<String, dynamic> section) {
    final shape = section['shape'];
    final coords = shape is Map ? shape['coordinates'] : shape;
    if (coords is! List) return const [];
    final out = <GeoPoint>[];
    for (final c in coords) {
      if (c is List && c.length >= 2) {
        final lng = (c[0] as num?)?.toDouble();
        final lat = (c[1] as num?)?.toDouble();
        if (lat != null && lng != null) out.add(GeoPoint(lat, lng));
      } else if (c is Map) {
        final lat = (c['lat'] as num?)?.toDouble();
        final lng = ((c['lon'] as num?) ?? (c['lng'] as num?))?.toDouble();
        if (lat != null && lng != null) out.add(GeoPoint(lat, lng));
      }
    }
    return out;
  }

  /// point セクション等の coord（{lat, lon|lng}）を GeoPoint へ変換する。
  GeoPoint? _coordOf(Map<String, dynamic> section) {
    final c = section['coord'];
    if (c is! Map) return null;
    final lat = (c['lat'] as num?)?.toDouble();
    final lon = ((c['lon'] as num?) ?? (c['lng'] as num?))?.toDouble();
    if (lat == null || lon == null) return null;
    return GeoPoint(lat, lon);
  }

  /// move（電車）セクションの運賃を取り出す。NAVITIME は運賃を
  /// `section.transport.fare` に格納する（calling_at と同じ階層）。互換のため
  /// section 直下の fare も後方で参照する。
  int? _fareOf(Map<String, dynamic> section) {
    final transport = section['transport'];
    final fare = transport is Map ? transport['fare'] : null;
    return _parseFare(fare ?? section['fare']);
  }

  /// NAVITIME の運賃は数値ではなく「unit_{料金区分ID}」をキーに持つオブジェクト
  /// （例: {"unit_0": 170, "unit_48": 165}）で返る。unit_48 が IC カード運賃、
  /// unit_0 が普通(きっぷ)運賃。IC 運賃を優先し、無ければ普通運賃、いずれも
  /// 無ければ最初に見つかった数値の運賃区分を採る。古い想定どおり数値で来た
  /// 場合にも備える。取り出せなければ null（運賃非表示）。
  int? _parseFare(dynamic fare) {
    if (fare is num) return fare.toInt();
    if (fare is Map) {
      for (final key in const ['unit_48', 'unit_0']) {
        final v = fare[key];
        if (v is num) return v.toInt();
      }
      for (final v in fare.values) {
        if (v is num) return v.toInt();
      }
    }
    return null;
  }

  /// move（電車）セクションの calling_at 駅座標を順序通りに取得する。
  /// shape が無いときの代替ジオメトリ（折れ線）に用いる。
  ///
  /// [_parseCalling] とは目的が異なり、こちらは _Stop を作らず座標だけを集める。
  /// どちらも時刻が欠落した駅でも座標があれば残す（[_parseCalling] の時刻欠落駅は
  /// 所要時間を [_rideMinutes] が距離から概算する）。
  List<GeoPoint> _callingCoords(Map<String, dynamic> sec) {
    final transport = sec['transport'];
    final raw =
        (transport is Map ? transport['calling_at'] : null) ??
        sec['calling_at'];
    if (raw is! List) return const [];
    final out = <GeoPoint>[];
    for (final e in raw) {
      if (e is Map<String, dynamic>) {
        final p = _coordOf(e);
        if (p != null) out.add(p);
      }
    }
    return out;
  }

  /// null を除いた座標が2点以上あれば折れ線（直線）にする。1点以下は空。
  List<GeoPoint> _lineFrom(List<GeoPoint?> points) {
    final out = [for (final p in points) ?p];
    return out.length >= 2 ? out : const [];
  }

  int _minutesBetween(DateTime later, DateTime earlier) =>
      (later.difference(earlier).inSeconds / 60).round();

  /// 出発の絶対時刻。dateOffset（isNow→0）で日付を決定する。NAVITIME の
  /// 時刻表（calling_at の from_time/to_time）と同じ基準でタイムラインの
  /// 待ち時間を算出するための基点に使う（#65）。
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

  /// 絶対時刻を NAVITIME の start_time（ISO8601・秒0固定）へ整形する。
  /// NAVITIME route_transit はタイムゾーンオフセット付きの start_time を受け付けず
  /// `parameter error` を返す（#121 で +09:00 を付けたところ全検索が 502 化した）。
  /// オフセットは元々不要：[_departureDateTime] は TZ 変換をせずユーザーが選んだ
  /// wall-clock の時・分をそのまま構成要素に持つため、ここで出力する数字は選択時刻
  /// そのもの。日本の公共交通ダイヤを引く NAVITIME はこれを JST として解釈するので、
  /// JST 以外の端末でも終電後判定はずれない。
  String _formatStartTime(DateTime dt) {
    final y = dt.year.toString().padLeft(4, '0');
    final mo = dt.month.toString().padLeft(2, '0');
    final d = dt.day.toString().padLeft(2, '0');
    final h = dt.hour.toString().padLeft(2, '0');
    final mi = dt.minute.toString().padLeft(2, '0');
    return '$y-$mo-${d}T$h:$mi:00';
  }
}

/// NAVITIME の時刻文字列（calling_at の from_time/to_time）を「JST の wall-clock を
/// 表す naive DateTime」へ正規化する（#121 TZ）。
///
/// 実 API は時刻に `+09:00` を付けて返し、[DateTime.parse] はそれを UTC インスタンス
/// （isUtc=true）にする。一方タイムラインの出発アンカー（[NaviTimeRouteService.
/// _departureDateTime]）はユーザー選択の壁時計値そのものを持つ naive DateTime で、
/// この両者を [DateTime.difference] すると端末 TZ ぶんずれる。JST 以外の端末では
/// 乗車待ちが負＝0 に化け、翌朝始発が「今すぐ乗れる深夜電車」として #121② の
/// フィルタを素通りしていた（深夜時刻表示の主因）。
///
/// NAVITIME のダイヤは常に JST。オフセット/Z 付き（[DateTime.isUtc]）なら +9h して
/// JST の壁時計成分を読み取り、オフセット無し（naive）なら数字をそのまま JST 壁時計と
/// みなす。いずれも isUtc=false の naive DateTime を返すため、同じく naive な出発
/// アンカーとの差分が端末 TZ に依存しなくなる。解析不能・null・空は null。
@visibleForTesting
DateTime? parseNavitimeJst(String? raw) {
  if (raw == null || raw.isEmpty) return null;
  final dt = DateTime.tryParse(raw);
  if (dt == null) return null;
  final jst = dt.isUtc ? dt.add(const Duration(hours: 9)) : dt;
  return DateTime(
    jst.year,
    jst.month,
    jst.day,
    jst.hour,
    jst.minute,
    jst.second,
  );
}

/// 解析済みの標準乗換経路。ハイブリッド構築に必要な停車駅タイムラインを保持する。
class _TransitParse {
  _TransitParse({
    required this.from,
    required this.to,
    required this.segments,
    required this.stops,
  });

  final String from;
  final String to;
  final List<RouteSegment> segments;

  /// 経路上の全電車区間の停車駅を出発側から順に並べたもの。
  final List<_Stop> stops;

  int get totalMin => segments.fold(0, (a, s) => a + s.minutes);

  RouteCandidate toCandidate() =>
      RouteCandidate(from: from, to: to, segments: segments);
}

/// 経路上の停車駅。乗車・降車の候補点になる。
class _Stop {
  _Stop({
    required this.name,
    required this.coord,
    required this.arr,
    required this.dep,
    required this.line,
    required this.section,
    required this.fare,
  });

  final String name;
  final GeoPoint coord;

  /// この駅への到着時刻（降車に使用）。calling_at に時刻が無ければ null。
  final DateTime? arr;

  /// この駅からの発車時刻（乗車に使用）。calling_at に時刻が無ければ null。
  final DateTime? dep;

  /// この駅から乗車する際の路線名。
  final String? line;

  /// この駅が属する乗車区間の通し番号。乗換をまたぐ駅は番号が異なる。
  /// 同一 section の駅は stops 配列上で連続する（運賃按分が前提にする不変条件）。
  final int section;

  /// この駅が属する乗車区間（セクション）全体の運賃。ハイブリッドの一部区間
  /// 運賃を距離按分するための基準。取得できなければ null。
  final int? fare;
}
