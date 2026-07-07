import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/activity_snapshot.dart';
import '../models/daily_activity.dart';
import '../models/geo_point.dart';
import '../models/location_state.dart';
import '../models/route_error.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import '../models/walk_summary.dart';
import '../navigation/nav_engine.dart';
import '../services/activity_log_repository.dart';
import '../services/activity_service.dart';
import '../services/activity_stats.dart';
import '../services/health_service.dart';
import '../services/location_service.dart';
import '../services/onboarding_repository.dart';
import '../services/route_plan_builder.dart' as planner;
import '../services/route_service.dart';
import 'settings_provider.dart';

/// 経路からこの距離（m）を超えて外れたらオフルートとみなす。GPS のブレは無視する。
const double kRerouteThresholdMeters = 50;

/// 起動時の初期到着時刻を「出発 + この分数」で算出する。ユーザーはホーム画面で
/// いつでも調整できるため、設定では持たず固定のシード値とする。
const int kInitialBudgetMinutes = 60;

/// 出発と到着の最小ギャップ（分）。これにより常に「出発 < 到着」を保証する。
const int kMinBudgetMinutes = 1;

/// 当日0時基準の絶対分から TimeValue を復元する（isNow は付かない）。
TimeValue _timeValueFromAbs(int abs) =>
    TimeValue(h: (abs ~/ 60) % 24, m: abs % 60, dateOffset: abs ~/ (24 * 60));

/// 出発を変更したときの到着。予算が最小ギャップ未満になる場合のみ、変更前の予算を
/// 保ったまま到着を後ろへずらす（カレンダー式）。前へ動かして予算が広がる場合は据置。
TimeValue _arrivalAfterDeparture(
  TimeValue newDeparture,
  TimeValue oldDeparture,
  TimeValue arrival,
) {
  final newDepAbs = planner.absoluteMinutes(newDeparture);
  if (planner.absoluteMinutes(arrival) - newDepAbs >= kMinBudgetMinutes) {
    return arrival;
  }
  final oldBudget =
      planner.absoluteMinutes(arrival) - planner.absoluteMinutes(oldDeparture);
  final keep = oldBudget >= kMinBudgetMinutes ? oldBudget : kMinBudgetMinutes;
  return _timeValueFromAbs(newDepAbs + keep);
}

/// 到着を変更したときの到着。出発 + 最小ギャップを下回らないようクランプする。
TimeValue _clampArrivalAfterDeparture(TimeValue departure, TimeValue arrival) {
  final minAbs = planner.absoluteMinutes(departure) + kMinBudgetMinutes;
  return planner.absoluteMinutes(arrival) >= minAbs
      ? arrival
      : _timeValueFromAbs(minAbs);
}

/// 自動再検索を発火するまでに必要な連続オフルート回数。瞬間的なノイズを除外する。
const int kRerouteSustainFixes = 3;

/// 一度再検索したら次まで空けるクールダウン。API 呼び出しの多発を防ぐ。
const Duration kRerouteCooldown = Duration(seconds: 30);

enum Screen {
  onboarding,
  home,
  settings,
  auth,
  search,
  searchOrigin,
  loading,
  result,
  nav,
  complete,
  error,
}

@immutable
class AppState {
  const AppState({
    required this.screen,
    required this.destination,
    required this.destinationLatLng,
    required this.departure,
    required this.arrival,
    required this.route,
    required this.locationState,
    this.origin,
    this.originLatLng,
    this.currentPosition,
    this.routeErrorKind,
    this.routePhase,
    this.walkSummary,
    this.streakDays = 0,
    this.weekKm = 0.0,
    this.todaySteps = 0,
    this.todayKm = 0.0,
    this.todayKcal = 0,
    this.isRerouting = false,
    this.rerouteFailed = false,
  });

  final Screen screen;
  final String? destination;
  final GeoPoint? destinationLatLng;
  final String? origin;
  final GeoPoint? originLatLng;

  /// ナビ中の最新の現在地。nav 以外では null。
  final GeoPoint? currentPosition;
  final TimeValue departure;
  final TimeValue arrival;
  final RoutePlan? route;
  final LocationState locationState;
  final RouteErrorKind? routeErrorKind;
  final RoutePhase? routePhase;

  /// 歩行完了時のシェア用サマリー。完了画面（[Screen.complete]）でのみ参照する。
  final WalkSummary? walkSummary;
  final int streakDays;
  final double weekKm;
  final int todaySteps;
  final double todayKm;
  final int todayKcal;

  /// オフルートからの自動再検索が進行中か。
  final bool isRerouting;

  /// 直近の自動再検索が失敗し、旧ルートを表示し続けている状態か。
  /// 次の再検索開始時にリセットされる（成功すれば false のまま）。
  final bool rerouteFailed;

  /// 出発〜到着の時間予算（分）。日跨ぎ（dateOffset / isNow）を考慮する。
  int get budgetMinutes => planner.budgetMinutes(departure, arrival);

  String get departureLabelText {
    if (origin != null) return origin!;
    return switch (locationState) {
      LocationLoading() => '現在地 · 取得中...',
      LocationAvailable() => '現在地',
      LocationDenied() => '位置情報なし',
      LocationUnavailable() => '現在地 · 取得失敗',
    };
  }

  /// 経路の出発ノードに表示する出発地名。手動指定の出発地、または位置が確定済みの
  /// 「現在地」を返す。取得中・位置情報なしの過渡値は表示に適さないため null を返し、
  /// NAVITIME 解析値（フォールバック）へ委ねる。
  String? get departureNameForRoute {
    if (origin != null) return origin;
    return switch (locationState) {
      LocationAvailable() => '現在地',
      LocationLoading() || LocationDenied() || LocationUnavailable() => null,
    };
  }

  AppState copyWith({
    Screen? screen,
    Object? destination = _sentinel,
    Object? destinationLatLng = _sentinel,
    Object? origin = _sentinel,
    Object? originLatLng = _sentinel,
    Object? currentPosition = _sentinel,
    TimeValue? departure,
    TimeValue? arrival,
    Object? route = _sentinel,
    LocationState? locationState,
    Object? routeErrorKind = _sentinel,
    Object? routePhase = _sentinel,
    Object? walkSummary = _sentinel,
    int? streakDays,
    double? weekKm,
    int? todaySteps,
    double? todayKm,
    int? todayKcal,
    bool? isRerouting,
    bool? rerouteFailed,
  }) {
    return AppState(
      screen: screen ?? this.screen,
      destination: identical(destination, _sentinel)
          ? this.destination
          : destination as String?,
      destinationLatLng: identical(destinationLatLng, _sentinel)
          ? this.destinationLatLng
          : destinationLatLng as GeoPoint?,
      origin: identical(origin, _sentinel) ? this.origin : origin as String?,
      originLatLng: identical(originLatLng, _sentinel)
          ? this.originLatLng
          : originLatLng as GeoPoint?,
      currentPosition: identical(currentPosition, _sentinel)
          ? this.currentPosition
          : currentPosition as GeoPoint?,
      departure: departure ?? this.departure,
      arrival: arrival ?? this.arrival,
      route: identical(route, _sentinel) ? this.route : route as RoutePlan?,
      locationState: locationState ?? this.locationState,
      routeErrorKind: identical(routeErrorKind, _sentinel)
          ? this.routeErrorKind
          : routeErrorKind as RouteErrorKind?,
      routePhase: identical(routePhase, _sentinel)
          ? this.routePhase
          : routePhase as RoutePhase?,
      walkSummary: identical(walkSummary, _sentinel)
          ? this.walkSummary
          : walkSummary as WalkSummary?,
      streakDays: streakDays ?? this.streakDays,
      weekKm: weekKm ?? this.weekKm,
      todaySteps: todaySteps ?? this.todaySteps,
      todayKm: todayKm ?? this.todayKm,
      todayKcal: todayKcal ?? this.todayKcal,
      isRerouting: isRerouting ?? this.isRerouting,
      rerouteFailed: rerouteFailed ?? this.rerouteFailed,
    );
  }

  static const _sentinel = Object();

  static const initial = AppState(
    screen: Screen.onboarding,
    destination: null,
    destinationLatLng: null,
    departure: TimeValue(h: 0, m: 0, isNow: true),
    arrival: TimeValue(h: 0, m: 0),
    route: null,
    locationState: LocationLoading(),
  );
}

class AppNotifier extends Notifier<AppState> {
  StreamSubscription<GeoPoint>? _posSub;
  StreamSubscription<ActivitySnapshot>? _activitySub;
  bool _disposed = false;

  /// 日次活動履歴のリポジトリ。永続化が使えない場合は null（メモリのみ動作）。
  ActivityLogRepository? _activityLog;

  /// 集計に使う活動履歴のメモリ上のキャッシュ。
  List<DailyActivity> _history = const [];

  /// 今セッション開始時点で今日に既に記録されていた歩数。
  /// セッションの累積歩数はこの値に積んで当日累計にする。
  int _todayBaseSteps = 0;

  /// 履歴ロードが完了し基準歩数が確定したか。完了前に届いた計測は
  /// [_pendingActivity] に保持し、ロード後にまとめて反映する。
  bool _historyLoaded = false;

  /// ロード完了前に届いた最新のセッション計測（累積値）。
  ActivitySnapshot? _pendingActivity;

  /// 連続してオフルートと判定された回数。閾値内に戻るとリセットする。
  int _offRouteFixes = 0;

  /// 直前フィックスでのポリライン沿い累積距離（メートル）。自己交差・並走
  /// 区間でのスナップジャンプを防ぐため [computeGuidance] へ渡す。
  double? _lastDistanceAlongMeters;

  /// 直近で自動再検索を実行した時刻。クールダウン判定に使う。
  DateTime? _lastRerouteAt;

  /// 現在のナビ（歩行）セッションの開始時刻。nav 入場で確定し退場で null に戻す。
  /// null のときはセッション外。ワークアウト書き込みの開始時刻に使う。
  DateTime? _sessionStart;

  /// ナビセッション開始時点の当日累計歩数。退場時の当日累計との差が
  /// そのセッションで歩いた歩数になる。
  int _sessionStartSteps = 0;

  /// 検索の世代番号。[startSearch] のたびに繰り上げ、[cancelSearch] でも繰り上げる。
  /// 進行中の `plan()` が完了・進捗通知した時点で開始時の世代と一致しなければ、
  /// その結果はキャンセル済み（または後続検索に上書きされた stale）として捨てる。
  int _searchGeneration = 0;

  @override
  AppState build() {
    ref.onDispose(() {
      _disposed = true;
      _posSub?.cancel();
      _activitySub?.cancel();
    });
    unawaited(_fetchLocation());
    unawaited(_startActivityTracking());
    final now = DateTime.now();
    final depH = now.hour;
    final depM = now.minute;
    // 完了済みならオンボーディングを飛ばして home から開始する。
    final initialScreen = ref.read(onboardingCompletedProvider)
        ? Screen.home
        : Screen.onboarding;
    // 日跨ぎ（深夜出発）は arrival の dateOffset に繰り上げる。
    final arrivalTotal = depH * 60 + depM + kInitialBudgetMinutes;
    return AppState.initial.copyWith(
      screen: initialScreen,
      departure: TimeValue(h: depH, m: depM, isNow: true),
      arrival: TimeValue(
        h: (arrivalTotal ~/ 60) % 24,
        m: arrivalTotal % 60,
        dateOffset: arrivalTotal ~/ (24 * 60),
      ),
    );
  }

  /// 現在地を再取得する。ホームのコンパスボタンから明示的に再要求するため公開する。
  Future<void> refreshLocation() => _fetchLocation();

  Future<void> _fetchLocation() async {
    try {
      final service = ref.read(locationServiceProvider);
      final result = await service.request();
      if (_disposed) return;
      state = state.copyWith(locationState: result);
    } catch (_) {
      if (_disposed) return;
      // service.request() は失敗理由を LocationState として返す設計だが、
      // 想定外の例外は権限拒否と断定できないため再試行可能な状態に寄せる。
      state = state.copyWith(locationState: const LocationUnavailable());
    }
  }

  /// 永続化された活動履歴を読み込み、ストリーク/週次/当日の集計を反映する。
  /// 並行して歩数センサーを購読し、セッション歩数を当日累計へ積む。
  /// 履歴ロードの I/O で購読確立を遅らせない（初回計測を取りこぼさない）。
  Future<void> _startActivityTracking() async {
    unawaited(_loadActivityHistory());
    try {
      final service = ref.read(activityServiceProvider);
      if (!await service.requestPermission() || _disposed) return;
      _activitySub = service.sessionActivityStream().listen(
        _onActivity,
        // センサー欠如や一時的なエラーで未捕捉例外を出さない。
        // デバッグ時のみ原因切り分けのためログに残す。
        onError: (Object e) {
          assert(() {
            debugPrint('activity stream error: $e');
            return true;
          }());
        },
      );
    } catch (_) {
      // 権限要求やセンサー初期化の失敗は計測なしとして無視する。
    }
  }

  /// 履歴をロードして起動時点の集計を反映する。永続化が使えない環境
  /// （プラグイン未登録のテスト等）ではメモリのみで計測を続行する。
  Future<void> _loadActivityHistory() async {
    try {
      final repo = await ref.read(activityLogRepositoryProvider.future);
      if (_disposed) return;
      _activityLog = repo;
      _history = await repo.load();
      if (_disposed) return;
      _todayBaseSteps = _todayStepsOf(_history);
      _applyActivityStats();
    } catch (_) {
      // 永続化が使えない場合はメモリ上の履歴（空）で継続する。
    } finally {
      _flushPendingActivity();
    }
  }

  /// 基準歩数の確定を記録し、ロード中に保留していた計測を反映する。
  /// ロード失敗時もメモリのみで計測を続行できるよう必ず確定させる。
  void _flushPendingActivity() {
    if (_disposed || _historyLoaded) return;
    _historyLoaded = true;
    final pending = _pendingActivity;
    _pendingActivity = null;
    if (pending != null) _onActivity(pending);
  }

  /// セッションの累積歩数 [snap] を当日の既存歩数へ積み、履歴を更新・永続化して
  /// ストリーク/週次/当日の集計を再計算する。
  void _onActivity(ActivitySnapshot snap) {
    if (_disposed) return;
    // 基準歩数の確定前に届いた計測は最新値だけ保持し、ロード後に反映する。
    // （セッション歩数は累積値なので最新の 1 件で十分。二重計上を防ぐ）
    if (!_historyLoaded) {
      _pendingActivity = snap;
      return;
    }
    final now = DateTime.now();
    final entry = DailyActivity(date: now, steps: _todayBaseSteps + snap.steps);
    _history = [
      for (final e in _history)
        if (e.dateKey != entry.dateKey) e,
      entry,
    ];
    final log = _activityLog;
    if (log != null) {
      // 永続化はベストエフォート。集計はメモリ上の履歴を真実とするため、
      // 保存失敗で未捕捉例外を投げない（デバッグ時のみ原因をログに残す）。
      unawaited(
        log.upsert(entry, now: now).catchError((Object e) {
          assert(() {
            debugPrint('activity persist error: $e');
            return true;
          }());
        }),
      );
    }
    _applyActivityStats(now);
  }

  /// メモリ上の履歴から [now]（既定は現在）時点の集計を state へ反映する。
  void _applyActivityStats([DateTime? now]) {
    final today = now ?? DateTime.now();
    final snap = ActivitySnapshot.fromSteps(_todayStepsOf(_history, today));
    state = state.copyWith(
      streakDays: computeStreak(_history, today),
      weekKm: weekKm(_history, today),
      todaySteps: snap.steps,
      todayKm: snap.km,
      todayKcal: snap.kcal,
    );
  }

  /// 履歴から [now]（既定は現在）の当日の歩数を返す。未記録なら 0。
  int _todayStepsOf(List<DailyActivity> history, [DateTime? now]) {
    final today = DailyActivity(date: now ?? DateTime.now(), steps: 0).dateKey;
    for (final e in history) {
      if (e.dateKey == today) return e.steps;
    }
    return 0;
  }

  void go(Screen s) => syncScreen(s);

  /// 歩行完了サマリーを確定し、完了画面（[Screen.complete]）へ遷移する。
  /// ナビ到着の自動検出、または「歩き終わった」の手動操作から呼ばれる。
  void finishWalk({
    required double distanceKm,
    required int kcal,
    required String from,
    required String to,
  }) {
    state = state.copyWith(
      walkSummary: WalkSummary(
        distanceKm: distanceKm,
        kcal: kcal,
        from: from,
        to: to,
      ),
    );
    syncScreen(Screen.complete);
  }

  /// screen を [s] に揃え、nav 出入りの GPS 追跡を開始/停止する。
  ///
  /// アプリ内遷移（[go]）と router からの書き戻し（pop / deep link /
  /// redirect）の両方がここを通るため、どの経路でも副作用が同一に発火する。
  /// 同値なら何もしない（router との相互同期がエコーで往復しないための冪等性）。
  void syncScreen(Screen s) {
    if (state.screen == s) return;
    state = state.copyWith(screen: s);
    if (s == Screen.nav) {
      _startTracking();
    } else {
      _stopTracking();
    }
  }

  void _startTracking() {
    if (_posSub != null) return;
    // ナビ（歩行）セッションの開始を記録する。退場時にこの時刻と、開始時点の
    // 当日累計歩数からの差分でワークアウトを組み立てる。
    _sessionStart = DateTime.now();
    _sessionStartSteps = state.todaySteps;
    _posSub = ref
        .read(locationServiceProvider)
        .positionStream()
        .listen(
          _onPosition,
          // GPS 喪失や位置サービス停止で流れるエラーは未捕捉例外にせず、
          // locationState に反映してナビ画面へバナー表示できるようにする。
          // 最後に取得した現在地はそのまま保持する（表示は消さない）。
          onError: (_) {
            if (_disposed) return;
            state = state.copyWith(locationState: const LocationUnavailable());
          },
        );
  }

  void _stopTracking() {
    _maybeWriteWorkout();
    _posSub?.cancel();
    _posSub = null;
    _offRouteFixes = 0;
    _lastDistanceAlongMeters = null;
    if (state.currentPosition != null) {
      state = state.copyWith(currentPosition: null);
    }
    // ナビ中の GPS 喪失/リルート失敗は退場後の検索画面（位置バイアス等）へ
    // 持ち越したくない。実際の現在地を取り直して locationState を最新化する。
    state = state.copyWith(rerouteFailed: false);
    unawaited(_fetchLocation());
  }

  /// HealthKit 連携がオンなら、今セッションの歩行をワークアウトとして書き込む。
  /// 歩数が増えていないセッションは書き込まない。書き込みはベストエフォートで、
  /// 失敗してもナビ体験を妨げない（デバッグ時のみ原因をログに残す）。
  void _maybeWriteWorkout() {
    final start = _sessionStart;
    _sessionStart = null;
    if (start == null) return;
    final sessionSteps = state.todaySteps - _sessionStartSteps;
    if (sessionSteps <= 0) return;
    final enabled = ref.read(settingsProvider).value?.healthKitEnabled ?? false;
    if (!enabled) return;
    final snap = ActivitySnapshot.fromSteps(sessionSteps);
    final workout = WalkingWorkout(
      start: start,
      end: DateTime.now(),
      steps: sessionSteps,
      km: snap.km,
      kcal: snap.kcal,
    );
    unawaited(
      ref.read(healthServiceProvider).writeWalkingWorkout(workout).catchError((
        Object e,
      ) {
        assert(() {
          debugPrint('healthkit workout write error: $e');
          return true;
        }());
        return false;
      }),
    );
  }

  /// 現在地の更新を反映し、オフルートが継続していれば自動再検索を起動する。
  /// ストリームエラー後に位置が復帰した場合、GPS喪失バナーを解消するため
  /// locationState も LocationAvailable に戻す。
  void _onPosition(GeoPoint p) {
    state = state.copyWith(
      currentPosition: p,
      locationState: LocationAvailable(p),
    );
    _maybeReroute(p);
  }

  /// 経路からの逸脱が [kRerouteSustainFixes] 回続いたら、クールダウンと
  /// 多重実行を避けつつ現在地起点の再検索を起動する。
  void _maybeReroute(GeoPoint p) {
    final route = state.route;
    if (route == null || state.isRerouting) return;

    final guidance = computeGuidance(
      route: route,
      current: p,
      previousDistanceAlongMeters: _lastDistanceAlongMeters,
    );
    _lastDistanceAlongMeters = guidance.traveledKm * 1000;
    // 電車区間はポリラインの間引き・簡略化で数十m単位のずれが出やすく、
    // 徒歩想定の閾値では誤ってリルートしてしまうため対象外にする。
    if (guidance.isOnTrainSegment ||
        guidance.offRouteMeters <= kRerouteThresholdMeters) {
      _offRouteFixes = 0;
      return;
    }

    _offRouteFixes++;
    if (_offRouteFixes < kRerouteSustainFixes) return;

    // クールダウン中はあえて _offRouteFixes をリセットしない。まだ逸脱が
    // 続いている状態なので、クールダウン明けの最初のフィックスで（再度
    // 連続を待たずに）すぐ再検索できるようにするため。
    final last = _lastRerouteAt;
    if (last != null && DateTime.now().difference(last) < kRerouteCooldown) {
      return;
    }

    unawaited(_reroute(p));
  }

  /// 現在地 [from] を起点に同じ目的地へルートを再計算し、成功時に差し替える。
  /// 失敗時は旧ルートを保持する（圏外などで案内が消えないように）。
  Future<void> _reroute(GeoPoint from) async {
    state = state.copyWith(isRerouting: true, rerouteFailed: false);
    final now = DateTime.now();
    try {
      final plan = await ref
          .read(routeServiceProvider)
          .plan(
            destination: state.destination,
            destinationLatLng: state.destinationLatLng,
            departure: TimeValue(h: now.hour, m: now.minute, isNow: true),
            arrival: state.arrival,
            origin: from,
            originName: state.departureNameForRoute,
          );
      if (_disposed) return;
      state = state.copyWith(route: plan, isRerouting: false);
      // 新しい経路のポリラインは旧経路と別物なので、直前の累積距離は無効。
      _lastDistanceAlongMeters = null;
    } catch (_) {
      if (_disposed) return;
      // 旧ルートは保持したまま、ナビ画面にバナー表示できるよう失敗を残す。
      state = state.copyWith(isRerouting: false, rerouteFailed: true);
    } finally {
      _offRouteFixes = 0;
      // クールダウンは再検索「開始時刻」を起点にする。完了時刻だと
      // ネットワーク遅延ぶんだけ窓が伸び、実効クールダウンがブレるため。
      _lastRerouteAt = now;
    }
  }

  void setDestination(String? name, {GeoPoint? latLng}) =>
      state = state.copyWith(destination: name, destinationLatLng: latLng);

  void setOrigin(String? name, {GeoPoint? latLng}) =>
      state = state.copyWith(origin: name, originLatLng: latLng);

  /// 日付・時刻ピッカーで確定した値を出発/到着に反映する。
  void applyPickedTime({
    required PickerMode mode,
    required int h,
    required int m,
    required int dateOffset,
  }) {
    final picked = TimeValue(h: h, m: m, dateOffset: dateOffset);
    // 常に「出発 < 到着」を保つ。出発変更時は到着を後ろへ自動シフト（予算維持）、
    // 到着変更時は出発+最小ギャップへクランプする。
    state = mode == PickerMode.depart
        ? state.copyWith(
            departure: picked,
            arrival: _arrivalAfterDeparture(
              picked,
              state.departure,
              state.arrival,
            ),
          )
        : state.copyWith(
            arrival: _clampArrivalAfterDeparture(state.departure, picked),
          );
  }

  Future<void> startSearch() async {
    // 不変条件: screen と、その画面の表示前提データ（loading↔routePhase、
    // result/nav↔route、error↔routeErrorKind）は必ず同一 copyWith で
    // まとめて更新する。app_router.dart の redirect ガードがこの前提で
    // deep link を弾くため、片方だけ設定すると正規遷移まで跳ね返される。
    //
    // ここは screen を [syncScreen] ではなく直接 copyWith する。startSearch は
    // home→loading→result/error のみを扱い nav を経由しないため GPS 副作用は
    // 不要で、screen 変更は goRouterProvider の ref.listen が router へ伝搬する。
    // nav へ遷移する新経路をここに足す場合は syncScreen を通すこと。
    //
    // 世代番号を採番し、進捗通知・成否の反映前に一致を確認する。ローディング中に
    // [cancelSearch]（または次の startSearch）が世代を進めていれば、この探索は
    // 破棄済みなので結果を state へ書かない（キャンセル後に古い応答がホームから
    // result へ引き戻すのを防ぐ・#221）。
    final generation = ++_searchGeneration;
    state = state.copyWith(
      screen: Screen.loading,
      routeErrorKind: null,
      routePhase: RoutePhase.routing,
    );
    final origin =
        state.originLatLng ??
        switch (state.locationState) {
          LocationAvailable(:final position) => position,
          _ => null,
        };
    try {
      final plan = await ref
          .read(routeServiceProvider)
          .plan(
            destination: state.destination,
            destinationLatLng: state.destinationLatLng,
            departure: state.departure,
            arrival: state.arrival,
            origin: origin,
            originName: state.departureNameForRoute,
            onProgress: (phase) {
              if (generation != _searchGeneration || _disposed) return;
              state = state.copyWith(routePhase: phase);
            },
          );
      if (generation != _searchGeneration || _disposed) return;
      state = state.copyWith(
        screen: Screen.result,
        route: plan,
        routeErrorKind: null,
        routePhase: null,
      );
    } catch (e) {
      if (generation != _searchGeneration || _disposed) return;
      state = state.copyWith(
        screen: Screen.error,
        routeErrorKind: classifyRouteError(e),
        routePhase: null,
      );
    }
  }

  /// ローディング中の探索をキャンセルしてホームへ戻す（#221）。世代番号を進めて
  /// 進行中の `plan()` を無効化し、後から完了・進捗通知が来ても [startSearch] 側で
  /// 破棄されるようにする。screen とローディングの表示前提データ（routePhase）を
  /// 同一 copyWith で一括更新し、redirect ガードの不変条件を保つ。screen 変更は
  /// [startSearch] と同様に ref.listen 経由で router へ伝搬する。
  ///
  /// 進行中の HTTP リクエスト自体は中断しない（`RouteService.plan` に中断手段は
  /// 無い）。応答は世代不一致で捨てるだけなので、体感は即ホームへ戻る一方、通信は
  /// 完了まで走り切る。
  void cancelSearch() {
    _searchGeneration++;
    state = state.copyWith(
      screen: Screen.home,
      routePhase: null,
      routeErrorKind: null,
    );
  }
}

final appStateProvider = NotifierProvider<AppNotifier, AppState>(
  AppNotifier.new,
);
