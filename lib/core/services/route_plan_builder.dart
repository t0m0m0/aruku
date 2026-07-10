import '../models/route_plan.dart';
import '../models/time_value.dart';

/// 徒歩 1km あたりの消費カロリー。徒歩区間のみに適用する。
const int kcalPerKm = 57;

/// 徒歩の平均速度（分速メートル）。候補選定フェーズで直線距離から所要時間を
/// 概算するのに使う（不動産表示の慣行 80m/分）。確定経路の表示値は Google
/// Routes の実測へ上書きされる。
///
/// 推定は直線距離ベースで実測（道なり）より短く出る＝楽観側だが、これは意図的。
/// 採用経路は確定後に Google 実測で再判定し、超過すれば予算内へフォールバックする
/// （不具合B）。この再判定は「予算内と見積もった候補」を上から外していく方向のみで
/// 働くため、推定を割増して足切りを厳しくすると、実測では間に合う候補を選定段階で
/// 除外しても回収できない（偽陰性）。よって足切りは楽観に保ち、超過の回収は実測側に任せる。
const double walkMetersPerMinute = 80.0;

/// 電車の平均速度（分速メートル）。calling_at に発着時刻が無い停車駅では時刻表の
/// 差で乗車時間を出せないため、停車駅を結ぶ折れ線長からこの速度で概算する
/// （各停・乗換・停車を含む実効平均 30km/h ≒ 500m/分）。時刻が揃う停車駅は
/// 精度の高い時刻表の差を優先する。
const double trainMetersPerMinute = 500.0;

/// isNow のときは dateOffset を無視して当日扱い。budget 計算と epoch で共有。
int effectiveOffset(TimeValue t) => t.isNow ? 0 : t.dateOffset;

/// 当日0時基準の絶対分。isNow / dateOffset を踏まえ日跨ぎ計算の共通基準にする。
int absoluteMinutes(TimeValue t) =>
    t.totalMinutes + effectiveOffset(t) * 24 * 60;

/// 出発〜到着の予算（分）。日跨ぎ（dateOffset / isNow）を考慮する。
int budgetMinutes(TimeValue departure, TimeValue arrival) =>
    absoluteMinutes(arrival) - absoluteMinutes(departure);

/// 出発時刻 + 経過分を "h:mm" へ整形（時は24で剰余）。
String formatClock(TimeValue dep, int addMinutes) {
  final total = dep.h * 60 + dep.m + addMinutes;
  final h = (total ~/ 60) % 24;
  final m = total % 60;
  return '$h:${m.toString().padLeft(2, '0')}';
}

/// 出発を基点とした経過分 [cum] を、区間 [seg] を経た時点へ進める。
/// [anchor]（出発の絶対時刻）が与えられ NAVITIME の発車時刻 [RouteSegment.depTime] が
/// ある電車区間では、駅着から発車までの待ち時間を吸収して進める（乗車前・乗り換え待ちを
/// 到着時刻に反映する #65）。乗車時間は到着時刻 [RouteSegment.arrTime] があればその差、
/// 無ければ距離概算 [RouteSegment.minutes] を使う（NAVITIME は降車駅の時刻を欠くことが
/// あるが、発車時刻があれば「いつ乗れるか」は NAVITIME の実時刻で算出できる）。
/// 戻り値の [wait] はこの区間に乗る前に待った分（タイムライン表示用）。
/// 発車時刻が欠落した区間や [anchor] 無しでは従来どおり所要分を加算し待ちは 0。
({int cum, int wait}) _advance(int cum, RouteSegment seg, DateTime? anchor) {
  final dep = seg.depTime;
  final arr = seg.arrTime;
  if (anchor != null && dep != null) {
    final boardRel = dep.difference(anchor).inMinutes;
    // 乗車時間は到着時刻があればその差、無ければ距離概算（seg.minutes）。
    final ride = arr != null
        ? arr.difference(anchor).inMinutes - boardRel
        : seg.minutes;
    // 降車が発車より前の不整合データ（ride < 0）は所要分にフォールバックする。
    if (ride >= 0) {
      // boardRel <= cum は発車後に駅着＝乗り遅れ。ここでは待ち0で乗車時間を足す近似で
      // 進める（乗り遅れは firstMissedTrain が検知し #115 で次便の実時刻へ差し替える）。
      final wait = boardRel > cum ? boardRel - cum : 0;
      return (cum: cum + wait + ride, wait: wait);
    }
  }
  return (cum: cum + seg.minutes, wait: 0);
}

/// 出発を基点に全区間を進めた到着までの総所要分（時刻表が揃う電車区間では
/// 乗車前・乗り換え待ちを含む #65）。[departureAt] は出発の絶対時刻で、省略時は
/// 時刻表を使わず各区間の所要分を累積する。選定（予算判定）と表示（タイムライン）が
/// 同じ到着時刻を用いるよう、累積ロジックを [_advance] に一本化して共有する。
int arrivalMinutes(List<RouteSegment> segments, DateTime? departureAt) {
  var cum = 0;
  for (final seg in segments) {
    cum = _advance(cum, seg, departureAt).cum;
  }
  return cum;
}

/// 徒歩実測を反映した [segments] を出発絶対時刻 [departureAt] で進め、NAVITIME の
/// 発車時刻を持つ電車区間のうち「予定列車に乗り遅れる」最初の区間を返す（無ければ null）。
/// 乗り遅れの基準は [_advance] と同一で、区間到着時点の累積分が発車相対分を超える
/// （`cum > boardRel`）こと。発車相対分ちょうどに着く場合は乗車できる扱いで対象外。
/// 返り値の [cumBefore] はその区間に着くまでの実累積分で、乗車駅からの時刻表再照会の
/// start_time（出発 + cumBefore）を組むのに使う（#115）。
/// 判定は発車時刻のみで行う：NAVITIME は降車駅の時刻を欠くことがあるが、発車時刻が
/// あれば「徒歩を延ばしてその列車に乗り遅れたか」は確定できる（着時刻があれば発車前着
/// =不整合データを併せて除外する）。発車時刻が欠落した区間は判定できないため対象外。
({int index, int cumBefore})? firstMissedTrain(
  List<RouteSegment> segments,
  DateTime departureAt,
) {
  var cum = 0;
  for (var i = 0; i < segments.length; i++) {
    final seg = segments[i];
    final dep = seg.depTime;
    final arr = seg.arrTime;
    if (seg.type == SegmentType.train && dep != null) {
      final boardRel = dep.difference(departureAt).inMinutes;
      // 着時刻があれば発車前着（ride < 0）の不整合データは対象外。乗り遅れは駅着が
      // 発車相対分を超える場合のみ（同時刻は待ち0で乗車できるため除外）。
      final consistent = arr == null || !arr.isBefore(dep);
      if (consistent && cum > boardRel) {
        return (index: i, cumBefore: cum);
      }
    }
    cum = _advance(cum, seg, departureAt).cum;
  }
  return null;
}

/// 出発から各時刻表付き電車に乗車するまでの待ち時間の最大値（分, #121 原因②）。駅着から
/// 発車までの待機分で、終電後は翌朝始発までの長い待ちがここに表れる。複数電車を含む経路
/// では「最初の電車には乗れても後続が翌朝始発」のケースを取りこぼさないよう、全電車区間の
/// 乗車待ちの最大を返す。時刻表の無い電車・電車を含まない経路（全徒歩）は 0。best-effort
/// 選定で「乗車待ちが予算を超える＝今夜乗れない電車」を全徒歩より後回しにする判定に使う。
int maxBoardingWait(List<RouteSegment> segments, DateTime departureAt) {
  var cum = 0;
  var maxWait = 0;
  for (final seg in segments) {
    final advanced = _advance(cum, seg, departureAt);
    if (seg.type == SegmentType.train &&
        seg.depTime != null &&
        advanced.wait > maxWait) {
      maxWait = advanced.wait;
    }
    cum = advanced.cum;
  }
  return maxWait;
}

/// transit（電車・バス）区間ノードの補足文。路線名があればそれを、無ければ区間種別に
/// 応じたフォールバックを表示する（乗車前待ちは前置きしない）。walk は
/// [_boardingNode] からしか呼ばれず transit 区間のみが渡るため到達しない。
String _transitSub(RouteSegment seg) {
  if (seg.line != null) return seg.line!;
  switch (seg.type) {
    case SegmentType.train:
      return '電車';
    case SegmentType.bus:
      return 'バス';
    case SegmentType.walk:
      return '';
  }
}

/// 区間種別が transit（電車・バス）か。walk との二値網羅なので、[SegmentType] に
/// ケースが追加されてもここがコンパイルエラーで検出漏れを教えてくれる。
bool _isTransit(SegmentType type) {
  switch (type) {
    case SegmentType.walk:
      return false;
    case SegmentType.train:
    case SegmentType.bus:
      return true;
  }
}

/// 乗車駅（発）ノードを作る。表示時刻は乗車駅着の累積分 [arrivalCum] に乗車前待ちを
/// 足した「発車時刻」。早着なら発車時刻、乗り遅れ・時刻欠落なら駅着時刻に化す（_advance
/// と同基準）。補足文は路線名。
TimelineNode _boardingNode(
  TimeValue departure,
  String place,
  RouteSegment seg,
  int arrivalCum,
  DateTime? departureAt,
) {
  final wait = _advance(arrivalCum, seg, departureAt).wait;
  return TimelineNode(
    time: formatClock(departure, arrivalCum + wait),
    place: place,
    sub: _transitSub(seg),
  );
}

/// 区間列から RoutePlan を構築する（合計距離・徒歩距離・kcal・徒歩比率・
/// タイムライン）。データ源（Google / NAVITIME）に依存しない純粋関数。
/// [departureAt] は出発の絶対時刻（時刻表データとの差で待ち時間を算出する基点）。
/// 省略時は時刻表を使わず累積所要分でタイムラインを組む。
RoutePlan buildRoutePlan({
  required String from,
  required String to,
  required List<RouteSegment> segments,
  required TimeValue departure,
  required int budgetMin,
  DateTime? departureAt,
}) {
  // 距離・所要ともに実質ゼロの徒歩レッグ（同駅乗換など #225）はノイズなので除外する。
  // segments と timelineNodes の 1:1 対応を保つため、ノード生成前にここで落とす。全データ源が
  // 通る共有関数なので、parser 側で漏れても表示前に確実に取り除く保険になる。
  segments = segments.where((s) => !s.isZeroWalk).toList();

  final totalKm = segments.fold<double>(0, (a, s) => a + (s.km ?? 0));
  final walkKm = segments
      .where((s) => s.type == SegmentType.walk)
      .fold<double>(0, (a, s) => a + (s.km ?? 0));
  final kcal = segments
      .where((s) => s.type == SegmentType.walk)
      .fold<int>(0, (a, s) => a + (s.kcal ?? 0));

  // 駅ごとに「着(arr)」「発(dep)」を分けて並べる（案B / Google マップ準拠）。乗車駅は
  // 発車時刻、降車駅は到着時刻を左に出す。直結乗換（電車→電車で間に徒歩が無い）でも
  // 「着」「発」の 2 行に分け、着行は cardBelow:false で次の発行へ連続させる。
  final nodes = <TimelineNode>[
    TimelineNode(time: formatClock(departure, 0), place: from, sub: '出発'),
  ];
  // from≈to の 0値ルートが 0値徒歩の除外で全滅した退化ケースでは生成ループが
  // 回らず到着ノードが欠落する。出発直後着として補い出発・到着の 2 ノードを残す。
  if (segments.isEmpty) {
    nodes.add(
      TimelineNode(
        time: formatClock(departure, 0),
        place: to,
        sub: 0 <= budgetMin ? '到着 · 制限内 ✓' : '到着',
      ),
    );
  }
  // 出発からの経過分。電車区間では待ち時間を含めて進む（#65）。
  var cum = 0;
  for (var i = 0; i < segments.length; i++) {
    final seg = segments[i];
    final cumAfter = _advance(cum, seg, departureAt).cum;
    final isLast = i == segments.length - 1;
    if (isLast) {
      nodes.add(
        TimelineNode(
          time: formatClock(departure, cumAfter),
          place: to,
          sub: cumAfter <= budgetMin ? '到着 · 制限内 ✓' : '到着',
        ),
      );
    } else {
      final next = segments[i + 1];
      final place = seg.toName;
      final incomingTransit = _isTransit(seg.type);
      final outgoingTransit = _isTransit(next.type);
      if (incomingTransit && outgoingTransit) {
        // 直結乗換：着行（無表示・カード無し）＋ 次のtransit区間の発行。
        nodes.add(
          TimelineNode(
            time: formatClock(departure, cumAfter),
            place: place,
            sub: '',
            cardBelow: false,
          ),
        );
        nodes.add(_boardingNode(departure, place, next, cumAfter, departureAt));
      } else if (outgoingTransit) {
        // 徒歩で着いて次がtransit＝乗車駅。発車時刻＋路線名（待ちがあれば前置き）。
        nodes.add(_boardingNode(departure, place, next, cumAfter, departureAt));
      } else {
        // transitで着いて次が徒歩（降車駅）、または徒歩→徒歩。到着時刻に「徒歩へ」。
        nodes.add(
          TimelineNode(
            time: formatClock(departure, cumAfter),
            place: place,
            sub: '徒歩へ',
          ),
        );
      }
    }
    cum = cumAfter;
  }
  // 待ち時間込みの到着までの総所要分（時刻表が無ければ累積所要分に一致する）。
  final totalMin = cum;

  return RoutePlan(
    from: from,
    to: to,
    totalKm: totalKm,
    totalMin: totalMin,
    budgetMin: budgetMin,
    kcal: kcal,
    walkKm: walkKm,
    walkRatio: totalKm == 0 ? 0 : walkKm / totalKm,
    segments: segments,
    timelineNodes: nodes,
  );
}
