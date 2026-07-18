import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/activity_snapshot.dart';
import '../models/daily_activity.dart';
import '../models/geo_point.dart';
import '../models/journey_progress.dart';
import '../models/location_state.dart';
import '../models/route_error.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import '../models/walk_summary.dart';
import '../navigation/nav_engine.dart';
import '../services/activity_log_repository.dart';
import '../services/activity_service.dart';
import '../services/activity_stats.dart';
import '../services/cancellation.dart';
import '../services/crash_reporter.dart';
import '../services/health_service.dart';
import '../services/location_service.dart';
import '../services/notification_service.dart';
import '../services/onboarding_repository.dart';
import '../services/route_plan_builder.dart' as planner;
import '../services/route_service.dart';
import 'settings_provider.dart';

/// 現在時刻の供給元。テストで時間経過を制御できるよう注入可能にする。既定は実時計。
typedef Now = DateTime Function();
final nowProvider = Provider<Now>((ref) => DateTime.now);

/// 経路からこの距離（m）を超えて外れたらオフルートとみなす。GPS のブレは無視する。
const double kRerouteThresholdMeters = 50;

/// isNow（今すぐ出発）経路が失効するまでの猶予。確定時刻からこれを超えて実時間が
/// 進むと、結果の到着時刻と実際の ETA が乖離する（乗るはずだった便に乗り遅れる）。
/// この場合は経路を無効化して現在時刻での再検索を促す（#264）。
const Duration kRouteFreshness = Duration(minutes: 5);

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

/// isNow 出発を [now] へ更新し、予算幅を保つよう到着も同じだけ後ろへずらす（#264）。
/// isNow でない固定出発（将来の予約）は時間経過で意味が変わらないため据え置く。
({TimeValue departure, TimeValue arrival}) _refreshedNowTimes(
  AppState state,
  DateTime now,
) {
  final departure = state.departure;
  if (!departure.isNow) {
    return (departure: departure, arrival: state.arrival);
  }
  final budget = planner.budgetMinutes(departure, state.arrival);
  final newDeparture = TimeValue(h: now.hour, m: now.minute, isNow: true);
  final newArrival = _timeValueFromAbs(
    planner.absoluteMinutes(newDeparture) + budget,
  );
  return (departure: newDeparture, arrival: newArrival);
}

/// 自動再検索を発火するまでに必要な連続オフルート回数。瞬間的なノイズを除外する。
const int kRerouteSustainFixes = 3;

/// 一度再検索したら次まで空けるクールダウン。API 呼び出しの多発を防ぐ。
const Duration kRerouteCooldown = Duration(seconds: 30);

enum Screen {
  onboarding,
  home,
  settings,
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
    this.routeAsOf,
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
    this.routeAlternatives = const [],
    this.journey,
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

  /// 現在案内中の1区間を外部地図へ引き継ぐための行程進捗（#305）。
  ///
  /// 不変条件: `journey != null ⇒ route != null`。[route] を差し替える・クリアする
  /// ときは同一 copyWith で journey も null にリセットする（currentLegIndex は
  /// 差し替え前の segments を指しており、別経路では無意味になるため）。
  final JourneyProgress? journey;

  final LocationState locationState;

  /// [route] と対になるパレート非劣解の代替案（#290）。result 画面の候補切替に使う。
  /// route を差し替える経路（新規検索成功・リルート成功・失効）では必ず同じ
  /// copyWith で更新する。リルート後・失効後は stale になるため空へ戻す。
  final List<RoutePlan> routeAlternatives;

  /// isNow（今すぐ出発）経路が前提とする「現在時刻」。確定時に設定し、この時刻から
  /// [kRouteFreshness] を超えて実時間が進むと失効する（#264）。固定出発（isNow=false）
  /// や経路が無い間は null（時間経過で失効しない）。[route] と寿命を揃える。
  final DateTime? routeAsOf;
  final RouteErrorKind? routeErrorKind;
  final RoutePhase? routePhase;

  /// isNow 経路が失効しているか。結果の到着時刻と実 ETA が乖離する境界を [now] で判定
  /// する。router の redirect と notifier の両方が同じ判定を共有するため純粋関数にする。
  ///
  /// 判定は [routeAsOf]（＝経路そのもののメタデータ）だけに依存し、現在の入力フォーム
  /// ([departure]) は見ない。routeAsOf は「now 基準で確定した経路」にのみ設定する不変条件
  /// を保つ（固定出発の検索・リルートでは null）。フォームを見ると、now 経路を残したまま
  /// 出発を固定へ変えた後などに、保持中の now 経路が失効判定から外れてしまう。
  bool isNowRouteExpired(DateTime now) =>
      route != null &&
      routeAsOf != null &&
      now.difference(routeAsOf!) >= kRouteFreshness;

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
    Object? routeAsOf = _sentinel,
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
    List<RoutePlan>? routeAlternatives,
    Object? journey = _sentinel,
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
      routeAsOf: identical(routeAsOf, _sentinel)
          ? this.routeAsOf
          : routeAsOf as DateTime?,
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
      routeAlternatives: routeAlternatives ?? this.routeAlternatives,
      journey: identical(journey, _sentinel)
          ? this.journey
          : journey as JourneyProgress?,
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

  /// セッション開始時点で履歴ロードが完了していたか。未完了だと基準歩数が
  /// 未確定（0）で始まり、退場時の差分が当日全歩数に膨れて過大計上になる。
  /// その場合はワークアウトを書き込まない（健康データへの過大書き込みを防ぐ）。
  bool _sessionBaselineValid = false;

  /// 検索の世代番号。[startSearch] のたびに繰り上げ、[cancelSearch] でも繰り上げる。
  /// 進行中の `plan()` が完了・進捗通知した時点で開始時の世代と一致しなければ、
  /// その結果はキャンセル済み（または後続検索に上書きされた stale）として捨てる。
  int _searchGeneration = 0;

  /// 進行中の検索のキャンセル境界（#259）。世代番号は「古い応答を state へ書かない」
  /// を担うが、それだけでは進行中の HTTP が完了まで走り切る。これを倒すと通信自体を
  /// 切り、以降の外部呼び出しを止める。
  CancellationToken? _activeCancellation;

  /// 自動リルートの世代番号（#261）。リルート開始のたびに繰り上げる。ナビ離脱・
  /// 新規検索・目的地変更でも繰り上げ、進行中リルートの応答が後着しても
  /// 開始時の世代と一致しなければ捨てる。検索用の [_searchGeneration] とは
  /// 別軸で回す（ナビ中のリルートは検索フローを経由しないため）。
  int _rerouteGeneration = 0;

  /// 進行中リルートのキャンセル境界（#261）。無効化時に倒して通信を切る。
  CancellationToken? _activeRerouteCancellation;

  /// 現在時刻。テストで時間経過を制御できるよう [nowProvider] 経由で取得する。
  DateTime _now() => ref.read(nowProvider)();

  @override
  AppState build() {
    ref.onDispose(() {
      _disposed = true;
      _activeCancellation?.cancel();
      _activeRerouteCancellation?.cancel();
      _posSub?.cancel();
      _activitySub?.cancel();
    });
    unawaited(_fetchLocation());
    unawaited(_startActivityTracking());
    // 通知トグルの切替に追従してストリーク途切れ警告を予約/取消する。活動更新時は
    // _applyActivityStats からも同期するため、トグル操作にも即応できる。
    ref.listen(
      settingsProvider.select((s) => s.value?.notificationsEnabled),
      (_, _) => _syncStreakReminder(DateTime.now()),
    );
    final now = _now();
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
      final crashReporter = ref.read(crashReporterProvider);
      final service = ref.read(activityServiceProvider);
      if (!await service.requestPermission() || _disposed) return;
      _activitySub = service.sessionActivityStream().listen(
        _onActivity,
        // センサー欠如や一時的なエラーで未捕捉例外を出さない。
        onError: (Object e, StackTrace stack) {
          crashReporter
              .recordError(e, stack, context: 'activity.stream')
              .ignore();
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
      final crashReporter = ref.read(crashReporterProvider);
      // 永続化はベストエフォート。集計はメモリ上の履歴を真実とするため、
      // 保存失敗で未捕捉例外を投げない。
      unawaited(
        log.upsert(entry, now: now).catchError((Object e, StackTrace stack) {
          crashReporter
              .recordError(e, stack, context: 'activity.persist')
              .ignore();
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
    _syncStreakReminder(today);
  }

  /// 通知が有効なら、今日のストリーク状況に応じて途切れ警告を予約/取消する。
  /// ベストエフォート（失敗してもアプリ体験を妨げない）。
  void _syncStreakReminder(DateTime now) {
    final crashReporter = ref.read(crashReporterProvider);
    final enabled =
        ref.read(settingsProvider).value?.notificationsEnabled ?? false;
    final service = ref.read(notificationServiceProvider);
    final Future<void> op;
    if (!enabled) {
      op = service.cancelStreakReminder();
    } else {
      op = switch (planStreakReminder(history: _history, now: now)) {
        ScheduleStreakReminder(when: final at, :final streakDays) =>
          service.scheduleStreakReminder(when: at, streakDays: streakDays),
        CancelStreakReminder() => service.cancelStreakReminder(),
      };
    }
    unawaited(
      op.catchError((Object e, StackTrace stack) {
        crashReporter
            .recordError(e, stack, context: 'notification.streak_reminder')
            .ignore();
      }),
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
    _sessionBaselineValid = _historyLoaded;
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
    // 離脱時点で in-flight のリルートを無効化する。後着応答が退場後の
    // 検索/別目的地の state を上書きしないように（#261）。
    _invalidateReroute();
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
  /// 失敗してもナビ体験を妨げない。
  void _maybeWriteWorkout() {
    final start = _sessionStart;
    final baselineValid = _sessionBaselineValid;
    _sessionStart = null;
    _sessionBaselineValid = false;
    if (start == null) return;
    // 基準歩数が未確定のまま始まったセッションは差分が過大になるため書き込まない。
    if (!baselineValid) return;
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
    final crashReporter = ref.read(crashReporterProvider);
    unawaited(
      ref.read(healthServiceProvider).writeWalkingWorkout(workout).catchError((
        Object e,
        StackTrace stack,
      ) {
        crashReporter
            .recordError(e, stack, context: 'healthkit.workout_write')
            .ignore();
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

  /// 進行中リルートを無効化し、[isRerouting] を解除する（#261）。世代を繰り上げて
  /// 後着応答を捨てさせ、キャンセルトークンを倒して通信自体を切る。ナビ離脱・
  /// 新規検索・目的地変更で呼び、旧目的地のリルートが現行 state を上書きするのを防ぐ。
  void _invalidateReroute() {
    _rerouteGeneration++;
    _activeRerouteCancellation?.cancel();
    _activeRerouteCancellation = null;
    if (state.isRerouting) {
      state = state.copyWith(isRerouting: false);
    }
  }

  /// 現在地 [from] を起点に同じ目的地へルートを再計算し、成功時に差し替える。
  /// 失敗時は旧ルートを保持する（圏外などで案内が消えないように）。
  ///
  /// plan() は非同期で、完了前にナビ離脱・新規検索・目的地変更が起こり得る。
  /// 反映前に世代一致・Screen.nav を確認し、後着した旧リルートが別目的地の
  /// 経路を上書きしないようにする（#261）。
  Future<void> _reroute(GeoPoint from) async {
    final generation = ++_rerouteGeneration;
    final cancellation = _activeRerouteCancellation = CancellationToken();
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
            cancellation: cancellation,
          );
      if (_isRerouteStale(generation)) return;
      // リルートは常に isNow:true で引き直す（歩行中＝今出発）。差し替えた経路は元の
      // フォームが固定出発でも now 基準なので、失効基準 routeAsOf を必ず更新する。
      // これを付けないと、ナビ離脱後に古い now リルートが失効せず再入場できてしまう（#264）。
      // 直前の代替案は差し替え前の経路に紐づく stale な選択肢なので空に戻す（#290）。
      state = state.copyWith(
        route: plan,
        routeAsOf: now,
        isRerouting: false,
        routeAlternatives: const [],
        journey: null,
      );
      // 新しい経路のポリラインは旧経路と別物なので、直前の累積距離は無効。
      _lastDistanceAlongMeters = null;
    } catch (_) {
      if (_isRerouteStale(generation)) return;
      // 旧ルートは保持したまま、ナビ画面にバナー表示できるよう失敗を残す。
      state = state.copyWith(isRerouting: false, rerouteFailed: true);
    } finally {
      // stale なリルートは新セッションのカウンタ・クールダウンを乱さないよう
      // 触らない（無効化側で isRerouting は既に解除済み）。
      if (generation == _rerouteGeneration) {
        _offRouteFixes = 0;
        // クールダウンは再検索「開始時刻」を起点にする。完了時刻だと
        // ネットワーク遅延ぶんだけ窓が伸び、実効クールダウンがブレるため。
        _lastRerouteAt = now;
      }
    }
  }

  /// リルート応答を state へ反映してよいか。破棄済み・世代不一致（離脱/新規検索/
  /// 目的地変更で無効化された）・nav 画面外のいずれかなら stale として捨てる。
  bool _isRerouteStale(int generation) =>
      _disposed ||
      generation != _rerouteGeneration ||
      state.screen != Screen.nav;

  void setDestination(String? name, {GeoPoint? latLng}) {
    // 目的地が変わると in-flight リルートは旧目的地の経路になる。無効化して
    // 後着応答が新目的地の state を上書きしないようにする（#261）。
    _invalidateReroute();
    state = state.copyWith(destination: name, destinationLatLng: latLng);
  }

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
    // 前回のナビで in-flight のリルートが残っていれば無効化する。新規検索の
    // 結果が出る前後に後着しても、この検索の経路を上書きしないように（#261）。
    _invalidateReroute();
    // 前回の検索が in-flight のまま再検索へ入る（キャンセルを挟まない連打）場合も、
    // 古い通信を放置せず切る。新しいトークンを採番して plan へ通す（#259）。
    _activeCancellation?.cancel();
    final cancellation = _activeCancellation = CancellationToken();
    // isNow 出発は起動時刻のまま腐るため、照会直前に現在時刻へ更新する（#264）。到着も
    // 予算幅を保って追従させ、plan() には更新後の時刻を渡す。ただし state への確定は
    // 成功時まで遅らせる。失敗して旧経路を残す場合に、ヘッダー（出発）だけ新時刻へ動いて
    // 旧経路のタイムラインとズレるのを防ぐため。
    final now = _now();
    final refreshed = _refreshedNowTimes(state, now);
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
            departure: refreshed.departure,
            arrival: refreshed.arrival,
            origin: origin,
            originName: state.departureNameForRoute,
            cancellation: cancellation,
            onProgress: (phase) {
              if (generation != _searchGeneration || _disposed) return;
              state = state.copyWith(routePhase: phase);
            },
          );
      if (generation != _searchGeneration || _disposed) return;
      // 照会中にバックグラウンド滞在で失効した（isNow で猶予超過）場合は、古い前提の
      // 結果を表示せず home へ戻して再検索を促す。復帰時は Screen.loading のため
      // onAppResumed では無効化できず、完了時のここが最後の砦になる（#264）。
      if (refreshed.departure.isNow &&
          _now().difference(now) >= kRouteFreshness) {
        _expireRoute(_now());
        return;
      }
      // 成功時に出発/到着/経路/失効基準をまとめて確定する。isNow 経路のみ routeAsOf を
      // 持つ（固定出発は時間経過で腐らないため null）。
      state = state.copyWith(
        screen: Screen.result,
        route: plan,
        routeAsOf: refreshed.departure.isNow ? now : null,
        departure: refreshed.departure,
        arrival: refreshed.arrival,
        routeErrorKind: null,
        routePhase: null,
        routeAlternatives: plan.alternatives,
        journey: null,
      );
    } catch (e) {
      if (generation != _searchGeneration || _disposed) return;
      // 失敗時は出発/到着も旧経路も routeAsOf も触らない。出発を確定していないので、
      // 旧経路を残してもヘッダーとタイムラインの前提時刻は一致したまま。routeAsOf を
      // 消すと旧経路が失効判定から外れ redirect が admit し続けるため残す（#264）。
      state = state.copyWith(
        screen: Screen.error,
        routeErrorKind: classifyRouteError(e),
        routePhase: null,
      );
    }
  }

  /// 結果画面から歩行（ナビ）を開始する（#264）。失効経路のままナビへ進むと ETA が
  /// 乖離するため、失効していれば nav へは入らず経路を無効化して再検索を促す（GPS 追跡を
  /// 起動させないため CTA でも明示的に判定する）。deep link / 履歴経由の入場は router の
  /// redirect が同じ判定で弾く。
  void startNavigation() {
    final now = _now();
    if (state.isNowRouteExpired(now)) {
      _expireRoute(now);
      return;
    }
    go(Screen.nav);
  }

  /// 結果画面で現在区間の行程を開始する（#305）。経路が無ければ何もしない。
  /// 既に開始済みなら維持する（再タップで開始時刻・歩数・区間を巻き戻さない）。
  void startJourney() {
    if (state.route == null || state.journey != null) return;
    state = state.copyWith(
      journey: JourneyProgress(
        currentLegIndex: 0,
        startedAt: _now(),
        startSteps: state.todaySteps,
      ),
    );
  }

  /// アプリがフォアグラウンド復帰したときに now 経路の時刻を再検証する（#264）。
  /// 結果表示中・ホーム退避中の失効経路は無効化して再検索を促す（メモリに残った失効
  /// 経路を掃除し、ホームの出発時刻の追従も回復させる）。ナビ中は歩行を中断させない
  /// ため無効化しない。経路を表示中は前提時刻とズレるため出発を書き換えない。
  ///
  /// 失効判定は routeAsOf（経路メタデータ）に依存する [isNowRouteExpired] に委ね、現在の
  /// 出発フォームでは分岐しない。固定出発から始めたナビのリルート経路（now 基準）も、
  /// フォームが isNow=false のまま失効させられるようにするため。
  void onAppResumed() {
    final now = _now();
    final onExpirableScreen =
        state.screen == Screen.result || state.screen == Screen.home;
    if (onExpirableScreen && state.isNowRouteExpired(now)) {
      _expireRoute(now);
      return;
    }
    _refreshNowDeparture();
  }

  /// 表示中の経路が無く、かつ検索も走っていないときだけ isNow 出発を現在時刻へ追従
  /// させ、予算幅を保って到着も更新する（#264）。経路を表示中に書き換えるとタイムラインの
  /// 前提時刻とヘッダーがズレる。検索中（[Screen.loading]）は in-flight の plan() が検索
  /// 開始時刻で進行しており、ここで書き換えると完了時に同じズレが起きる（route はまだ
  /// null なので上の条件では防げない）。次の検索は [startSearch] 冒頭で必ず現在時刻へ
  /// 更新するので、表示の追従を省いても正しさは保てる。
  void _refreshNowDeparture() {
    if (!state.departure.isNow ||
        state.route != null ||
        state.screen == Screen.loading) {
      return;
    }
    final refreshed = _refreshedNowTimes(state, _now());
    state = state.copyWith(
      departure: refreshed.departure,
      arrival: refreshed.arrival,
    );
  }

  /// 失効した isNow 経路を破棄し、現在時刻へ更新した条件で home へ戻して再検索を促す
  /// （#264）。自動で再検索はしない（意図しない課金 API 呼び出しを避ける）。
  /// route と routeAsOf を同時に落とし、routePhase・routeErrorKind も掃除して
  /// redirect ガードの前提（画面と表示前提データの整合）を保つ。
  void _expireRoute(DateTime now) {
    _invalidateReroute();
    final refreshed = _refreshedNowTimes(state, now);
    state = state.copyWith(
      screen: Screen.home,
      route: null,
      routeAsOf: null,
      routePhase: null,
      routeErrorKind: null,
      departure: refreshed.departure,
      arrival: refreshed.arrival,
      routeAlternatives: const [],
      journey: null,
    );
  }

  /// 結果画面の候補カードから代替案 [index] を選ぶ。確定経路と代替案を入れ替え、
  /// 何度でも行き来できるようにする（#290）。範囲外 index や経路未確定は no-op。
  /// 画面遷移はしない（result 画面のまま再描画させる）。
  void selectAlternative(int index) {
    final current = state.route;
    final alternatives = state.routeAlternatives;
    if (current == null || index < 0 || index >= alternatives.length) return;
    state = state.copyWith(
      route: alternatives[index],
      routeAlternatives: [
        for (var i = 0; i < alternatives.length; i++)
          i == index ? current : alternatives[i],
      ],
      journey: null,
    );
  }

  /// ローディング中の探索をキャンセルしてホームへ戻す（#221）。世代番号を進めて
  /// 進行中の `plan()` を無効化し、後から完了・進捗通知が来ても [startSearch] 側で
  /// 破棄されるようにする。screen とローディングの表示前提データ（routePhase）を
  /// 同一 copyWith で一括更新し、redirect ガードの不変条件を保つ。screen 変更は
  /// [startSearch] と同様に ref.listen 経由で router へ伝搬する。
  ///
  /// 進行中のキャンセルトークンを倒し、進行中の HTTP を切る（#259）。世代番号だけの
  /// 頃は応答を捨てるだけで通信は完了まで走り切っていたが、トークンの close で
  /// ソケットごと落とし、以降の外部呼び出し（課金 API・App Check トークン）を止める。
  void cancelSearch() {
    _searchGeneration++;
    _activeCancellation?.cancel();
    _activeCancellation = null;
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
