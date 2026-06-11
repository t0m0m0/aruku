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
import '../navigation/nav_engine.dart';
import '../services/activity_log_repository.dart';
import '../services/activity_service.dart';
import '../services/activity_stats.dart';
import '../services/location_service.dart';
import '../services/onboarding_repository.dart';
import '../services/route_plan_builder.dart' as planner;
import '../services/route_service.dart';

/// 経路からこの距離（m）を超えて外れたらオフルートとみなす。GPS のブレは無視する。
const double kRerouteThresholdMeters = 50;

/// 起動時の初期到着時刻を「出発 + この分数」で算出する。ユーザーはホーム画面で
/// いつでも調整できるため、設定では持たず固定のシード値とする。
const int kInitialBudgetMinutes = 60;

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
    this.streakDays = 0,
    this.weekKm = 0.0,
    this.todaySteps = 0,
    this.todayKm = 0.0,
    this.todayKcal = 0,
    this.isRerouting = false,
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
  final int streakDays;
  final double weekKm;
  final int todaySteps;
  final double todayKm;
  final int todayKcal;

  /// オフルートからの自動再検索が進行中か。
  final bool isRerouting;

  /// 出発〜到着の時間予算（分）。日跨ぎ（dateOffset / isNow）を考慮する。
  int get budgetMinutes => planner.budgetMinutes(departure, arrival);

  String get departureLabelText {
    if (origin != null) return origin!;
    return switch (locationState) {
      LocationLoading() => '現在地 · 取得中...',
      LocationAvailable() => '現在地',
      LocationDenied() => '位置情報なし',
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
    int? streakDays,
    double? weekKm,
    int? todaySteps,
    double? todayKm,
    int? todayKcal,
    bool? isRerouting,
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
      streakDays: streakDays ?? this.streakDays,
      weekKm: weekKm ?? this.weekKm,
      todaySteps: todaySteps ?? this.todaySteps,
      todayKm: todayKm ?? this.todayKm,
      todayKcal: todayKcal ?? this.todayKcal,
      isRerouting: isRerouting ?? this.isRerouting,
    );
  }

  static const _sentinel = Object();

  static const initial = AppState(
    screen: Screen.onboarding,
    destination: null,
    destinationLatLng: null,
    departure: TimeValue(h: 0, m: 0, isNow: true, anchored: true),
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

  /// 直近で自動再検索を実行した時刻。クールダウン判定に使う。
  DateTime? _lastRerouteAt;

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
    final depM = _roundTo5(now.minute);
    // 完了済みならオンボーディングを飛ばして home から開始する。
    final initialScreen = ref.read(onboardingCompletedProvider)
        ? Screen.home
        : Screen.onboarding;
    // 日跨ぎ（深夜出発）は arrival の dateOffset に繰り上げる。
    final arrivalTotal = depH * 60 + depM + kInitialBudgetMinutes;
    return AppState.initial.copyWith(
      screen: initialScreen,
      departure: TimeValue(h: depH, m: depM, isNow: true, anchored: true),
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
      state = state.copyWith(locationState: const LocationDenied());
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

  void go(Screen s) {
    state = state.copyWith(screen: s);
    if (s == Screen.nav) {
      _startTracking();
    } else {
      _stopTracking();
    }
  }

  void _startTracking() {
    if (_posSub != null) return;
    _posSub = ref
        .read(locationServiceProvider)
        .positionStream()
        .listen(
          _onPosition,
          // GPS 喪失や位置サービス停止で流れる一時的なエラーは無視し、
          // 未捕捉例外を防ぐ。最後に取得した現在地を保持する。
          onError: (_) {},
        );
  }

  void _stopTracking() {
    _posSub?.cancel();
    _posSub = null;
    _offRouteFixes = 0;
    if (state.currentPosition != null) {
      state = state.copyWith(currentPosition: null);
    }
  }

  /// 現在地の更新を反映し、オフルートが継続していれば自動再検索を起動する。
  void _onPosition(GeoPoint p) {
    state = state.copyWith(currentPosition: p);
    _maybeReroute(p);
  }

  /// 経路からの逸脱が [kRerouteSustainFixes] 回続いたら、クールダウンと
  /// 多重実行を避けつつ現在地起点の再検索を起動する。
  void _maybeReroute(GeoPoint p) {
    final route = state.route;
    if (route == null || state.isRerouting) return;

    final offRoute = computeGuidance(route: route, current: p).offRouteMeters;
    if (offRoute <= kRerouteThresholdMeters) {
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
    state = state.copyWith(isRerouting: true);
    final now = DateTime.now();
    try {
      final plan = await ref
          .read(routeServiceProvider)
          .plan(
            destination: state.destination,
            destinationLatLng: state.destinationLatLng,
            departure: TimeValue(
              h: now.hour,
              m: _roundTo5(now.minute),
              isNow: true,
              anchored: true,
            ),
            arrival: state.arrival,
            origin: from,
          );
      if (_disposed) return;
      state = state.copyWith(route: plan, isRerouting: false);
    } catch (_) {
      if (_disposed) return;
      state = state.copyWith(isRerouting: false);
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
  /// 確定した側を anchor し、反対側の anchor を外す。
  void applyPickedTime({
    required PickerMode mode,
    required int h,
    required int m,
    required int dateOffset,
  }) {
    if (mode == PickerMode.depart) {
      state = state.copyWith(
        departure: TimeValue(
          h: h,
          m: m,
          anchored: true,
          dateOffset: dateOffset,
        ),
        arrival: state.arrival.copyWith(anchored: false),
      );
    } else {
      state = state.copyWith(
        departure: state.departure.copyWith(anchored: false),
        arrival: TimeValue(h: h, m: m, anchored: true, dateOffset: dateOffset),
      );
    }
  }

  Future<void> startSearch() async {
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
            onProgress: (phase) => state = state.copyWith(routePhase: phase),
          );
      state = state.copyWith(
        screen: Screen.result,
        route: plan,
        routeErrorKind: null,
        routePhase: null,
      );
    } catch (e) {
      state = state.copyWith(
        screen: Screen.error,
        routeErrorKind: classifyRouteError(e),
        routePhase: null,
      );
    }
  }

  static int _roundTo5(int m) {
    final rounded = ((m + 2) ~/ 5) * 5;
    return rounded.clamp(0, 55);
  }
}

final appStateProvider = NotifierProvider<AppNotifier, AppState>(
  AppNotifier.new,
);
