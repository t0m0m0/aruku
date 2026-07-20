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
import '../navigation/leg_handoff.dart';
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

/// 外部地図からの復帰時、pedometer の累積歩数がフォアグラウンドへ追いつくのを
/// 待つ上限。位置取得だけが先に終わっても、最終区間の Workout を古い歩数で
/// 確定しないための短い同期猶予（#305）。センサー無反応時は復帰処理を塞がない。
const Duration _journeyActivityCatchUpTimeout = Duration(seconds: 1);

/// 到着済み徒歩区間の計画距離に対し、この割合以上の実歩行が反映されていれば
/// pedometer が十分追いついたとみなす。経路短縮やセンサー過少計測を許容しつつ、
/// handoff 直後の小さな部分スナップショットで Workout を確定しないための下限。
const double _journeyActivityCatchUpMinLegDistanceRatio = 0.5;

/// 距離欠落・極短区間でも、単発のごく小さい部分値を同期完了にしないための実歩行下限。
const double _journeyActivityCatchUpMinDistanceKm = 0.05;

/// 外部地図利用中から復帰後までの歩数同期待機結果。handoff の置き換えと、最新値を
/// 評価する同期猶予の満了を区別し、古い区間の Workout を確定しないために使う。
enum _JourneyActivityCatchUpResult { superseded, settled }

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
    this.journeyManualCompletionAvailable = false,
    this.journeyCurrentLegHandedOff = false,
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

  /// 現在の行程区間について、直近の復帰時到着確認後に手動完了を許可するか。
  /// 位置取得失敗、または有効な現在地が到着閾値外だった場合に true となる。
  final bool journeyManualCompletionAvailable;

  /// 現在の行程区間を外部地図へ handoff（Google Maps 起動）済みか。区間を進めるたびに
  /// false へ戻す。geometry 欠落区間の手動完了ボタンを、まだ出発していない区間で先に
  /// 見せて1タップで飛ばさないためのガード。
  final bool journeyCurrentLegHandedOff;

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
    bool? journeyManualCompletionAvailable,
    bool? journeyCurrentLegHandedOff,
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
      journeyManualCompletionAvailable:
          journeyManualCompletionAvailable ??
          this.journeyManualCompletionAvailable,
      journeyCurrentLegHandedOff:
          journeyCurrentLegHandedOff ?? this.journeyCurrentLegHandedOff,
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

  /// 外部地図への handoff ごとの歩数同期待機境界。最初の活動イベントでは完了せず、
  /// 新しい handoff・画面離脱時に古い最終区間処理を中断するために使う。
  Completer<_JourneyActivityCatchUpResult>? _resumeActivityCatchUp;

  /// 上のシグナルを開始した経路・行程セッション。復帰前に更新済みの場合や、復帰後に
  /// 手動完了する場合も同じ更新を使えるよう、区間進行をまたいで次の handoff まで保持する。
  /// 代替案選択や新しい行程では一致しないため使わない。
  RoutePlan? _resumeActivityCatchUpRoute;
  JourneyProgress? _resumeActivityCatchUpJourney;

  /// 歩数の到着を待っている徒歩区間の一覧（区間 index と handoff 起動時点の当日累計歩数）。
  /// 完了判定は「保留中の全区間が閾値に達したか」で行う。前の徒歩の歩数が未了のまま次の
  /// 徒歩・電車へ進む場合も両方を追跡し、先に前区間だけ追いついても現在区間の歩数を
  /// 取りこぼして早期完了しないようにする。行程リセット・離脱でのみ破棄する。
  final List<({int legIndex, int startSteps})> _pendingWalkCatchUps = [];

  /// currentLegStartedAt を handoff 起動時刻に合わせた徒歩区間の index。同じ区間を
  /// 何度 handoff しても最初の起動時刻を保ち、再タップで歩行時間を巻き戻さない。
  int? _walkTimerLegIndex;

  /// 手動完了の処理中フラグ。await 中の連打で次区間まで一気に進めないよう再入を防ぐ。
  bool _manualCompletionInFlight = false;

  /// 復帰時の位置再取得の世代。歩数同期シグナルとは別に世代管理し、同じ handoff の
  /// 歩数更新を保持したまま、後続の復帰より古い位置取得だけを破棄する。
  int _journeyResumeGeneration = 0;

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
      _supersedeResumeActivityCatchUp();
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

  /// 現在地を単発取得し locationState へ反映する。反映した最新の判定を返す
  /// （復帰時の区間再評価が取得成否と座標を参照するため）。破棄済みなら null。
  Future<LocationState?> _fetchLocation() async {
    try {
      final service = ref.read(locationServiceProvider);
      final result = await service.request();
      if (_disposed) return null;
      state = state.copyWith(locationState: result);
      return result;
    } catch (_) {
      if (_disposed) return null;
      // service.request() は失敗理由を LocationState として返す設計だが、
      // 想定外の例外は権限拒否と断定できないため再試行可能な状態に寄せる。
      state = state.copyWith(locationState: const LocationUnavailable());
      return const LocationUnavailable();
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
    // 結果ハブを離れる操作は、外部地図を使った行程の放棄として扱う。home への back
    // だけでなく、deep link / 旧導線で nav 等へ移る場合も syncScreen を通るため、
    // ここで journey を破棄して別画面に非表示の行程を残さない（#305）。route は
    // result への戻り表示に使える既存挙動を維持するため残す。
    final abandonsJourney = state.screen == Screen.result;
    if (abandonsJourney) _supersedeResumeActivityCatchUp();
    state = state.copyWith(
      screen: s,
      journey: abandonsJourney ? null : state.journey,
      journeyManualCompletionAvailable: abandonsJourney
          ? false
          : state.journeyManualCompletionAvailable,
    );
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
    _writeWorkout(
      start: start,
      end: DateTime.now(),
      steps: state.todaySteps - _sessionStartSteps,
    );
  }

  /// HealthKit 連携がオンなら [start]〜[end] の歩行を [steps] 歩のワークアウトとして
  /// 書き込む。歩数が増えていない（[steps] <= 0）セッションは書き込まない。書き込みは
  /// ベストエフォートで、失敗しても体験を妨げない。nav セッションの退場（[_maybeWriteWorkout]）
  /// と行程セッションの完了（[advanceToLeg]）の両方がここを通り、二重書き込みを避ける。
  void _writeWorkout({
    required DateTime start,
    required DateTime end,
    required int steps,
  }) {
    if (steps <= 0) return;
    final enabled = ref.read(settingsProvider).value?.healthKitEnabled ?? false;
    if (!enabled) return;
    final snap = ActivitySnapshot.fromSteps(steps);
    final workout = WalkingWorkout(
      start: start,
      end: end,
      steps: steps,
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

  /// 区間 CTA の初回タップ（行程未開始）で、失効した isNow 経路のまま外部地図へ
  /// 引き継ぐのを防ぐ（#305）。旧導線 [startNavigation] がタップ時に行っていた失効判定を
  /// 新 CTA でも共有する。失効していれば経路を無効化して true を返し、呼び出し側は外部
  /// 起動をスキップする（無効化で redirect ガードが画面を遷移させるため、起動失敗バナーは
  /// 出さない）。
  ///
  /// 行程開始済み（[state.journey] != null）は継続を優先し、失効していても無効化しない
  /// （#264 の onAppResumed 例外と整合。歩行中の行程を途中で消さない）。判定・無効化を
  /// notifier 側へ寄せ、widget は起動可否だけを扱う。
  bool expireStaleBeforeHandoff() {
    if (state.journey != null) return false;
    final now = _now();
    if (!state.isNowRouteExpired(now)) return false;
    _expireRoute(now);
    return true;
  }

  /// 結果画面で現在区間の行程を開始する（#305）。経路が無ければ何もしない。
  /// 既に開始済みなら維持する（再タップで開始時刻・歩数・区間を巻き戻さない）。
  ///
  /// 開始時点の基準歩数の確定状況（[_historyLoaded]）を捕捉する。nav セッションの
  /// `_sessionBaselineValid` と同じ基準で、未確定のまま始まった行程は完了時の差分が
  /// 当日全歩数に膨れるため、[advanceToLeg] の HealthKit 書き込みで抑止する。
  void startJourney() {
    if (state.route == null || state.journey != null) return;
    _supersedeResumeActivityCatchUp();
    final now = _now();
    state = state.copyWith(
      journey: JourneyProgress(
        currentLegIndex: 0,
        startedAt: now,
        startSteps: state.todaySteps,
        startBaselineValid: _historyLoaded,
        currentLegStartedAt: now,
      ),
      journeyManualCompletionAvailable: false,
      // 行程開始は先頭区間の handoff と同時に起きる（本番では起動成功時のみ）。
      // 先頭区間は handoff 済みとして扱い、復帰時の到着判定・手動完了を許可する。
      journeyCurrentLegHandedOff: true,
    );
    // 先頭区間が徒歩なら、開始時点の歩数を基準に歩数到着待ちを登録する。区間に入った
    // 時点で捕捉することで、歩き終えて復帰した後に登録して差分を取りこぼす事故を防ぐ。
    _ensurePendingWalkCatchUp(state.route!, 0);
  }

  /// 外部 URL 起動の await 前に捕捉した経路・行程・区間が現在も表示中の場合だけ行程を
  /// 開始する。結果画面の離脱や代替案選択後に古い Future が完了しても、非表示または
  /// 別経路の行程を開始しない。WidgetRef を async gap 後に参照せずに検証できるよう、
  /// 状態の権威である notifier 側へ境界を置く。
  void startJourneyIfHandoffStillCurrent({
    required RoutePlan expectedRoute,
    required JourneyProgress? expectedJourney,
    required int expectedLegIndex,
  }) {
    if (state.screen != Screen.result ||
        !identical(state.route, expectedRoute) ||
        !identical(state.journey, expectedJourney) ||
        (state.journey?.currentLegIndex ?? 0) != expectedLegIndex) {
      return;
    }
    startJourney();
    final journey = state.journey;
    if (journey == null) return;
    // 現在区間を外部地図へ handoff した。geometry 欠落区間の手動完了は、この起動（または
    // 復帰）より後にだけ許可し、まだ出発していない区間を先に飛ばせないようにする。
    state = state.copyWith(journeyCurrentLegHandedOff: true);
    // 電車・バス区間の handoff では歩数同期を張り替えない。直前の徒歩区間の未了同期を
    // 保持したまま、乗車後の最終完了までその徒歩歩数を待たせる（transit は新しい歩数を
    // 生まないため、ここで transit 区間の同期を始めると徒歩の未反映分を取りこぼす）。
    if (legAt(expectedRoute, journey.currentLegIndex)?.type !=
        SegmentType.walk) {
      return;
    }
    // 徒歩区間のタイマーは、前区間完了時ではなく CTA を押して外部地図へ発った瞬間から
    // 計る。前区間完了〜起動までのハブ滞在・駅待ちを歩行時間（walkElapsed）に含めない。
    // 同じ区間を何度 handoff しても最初の起動時刻を保ち、再タップで歩行時間を巻き戻さない。
    if (_walkTimerLegIndex != journey.currentLegIndex) {
      state = state.copyWith(
        journey: journey.copyWith(currentLegStartedAt: _now()),
      );
      _walkTimerLegIndex = journey.currentLegIndex;
    }
    final walkJourney = state.journey!;
    // 完了待ちシグナルが無ければ張る。
    if (_matchingResumeActivityCatchUp(expectedRoute, walkJourney) == null) {
      _startResumeActivityCatchUp(expectedRoute, walkJourney);
    }
    // 歩数到着待ちは「区間に入った時点」ではなく「この徒歩を handoff した時点」の歩数を
    // 基準に登録する。電車降車〜徒歩CTAの間の駅歩き歩数を徒歩区間の歩数に数えて早期成立
    // させないため（同じ区間の再 handoff では既存基準を保つ）。
    _ensurePendingWalkCatchUp(expectedRoute, walkJourney.currentLegIndex);
  }

  /// 結果画面（ハブ）で現在区間を [index] へ進める（#305）。区間到着の自動検出
  /// （コミット4以降）と、区間 CTA からの手動進行の両方がここを通る想定。
  /// journey 未開始・経路未確定は no-op。index は 0〜segments.length にクランプする
  /// （segments.length は「全区間完了」を表す番兵値）。
  void advanceToLeg(int index) => _advanceToLeg(index);

  /// geometry 欠落、または復帰時の到着確認後に手動完了可能となった現在区間を進める。
  /// 最終区間では、
  /// 外部地図からの復帰後に pedometer の累積値が遅れて届く場合があるため、自動到着と
  /// 同じ追いつき処理を通してから Workout を確定する。
  Future<void> advanceCurrentLegManually() async {
    // 連打で await 中に再入すると、まだ handoff していない次区間まで一気に進めてしまう。
    // 処理中は後続タップを無視し、1タップ＝1区間だけ進める。
    if (_manualCompletionInFlight) return;
    final route = state.route;
    final journey = state.journey;
    if (route == null || journey == null || state.screen != Screen.result) {
      return;
    }
    final leg = legAt(route, journey.currentLegIndex);
    if (leg == null ||
        (leg.polyline.isNotEmpty && !state.journeyManualCompletionAvailable)) {
      return;
    }
    _manualCompletionInFlight = true;
    try {
      await _advanceJourneyLegAfterActivityCatchUp(
        expectedRoute: route,
        expectedJourney: journey,
        activityCatchUp: _matchingResumeActivityCatchUp(route, journey),
      );
    } finally {
      _manualCompletionInFlight = false;
    }
  }

  void _advanceToLeg(int index, {bool writeWorkoutOnCompletion = true}) {
    final route = state.route;
    final journey = state.journey;
    if (route == null || journey == null) return;
    final previous = journey.currentLegIndex;
    final clamped = index.clamp(0, route.segments.length);
    final now = _now();
    // 直前に案内していた区間が徒歩なら、その実経過時間を歩行時間へ積み、終了時刻を控える。
    // 混在ルートでは電車・バス区間の乗車時間を除外し、徒歩ワークアウトの期間を膨らませない。
    final completedLeg = clamped > previous ? legAt(route, previous) : null;
    final completedWalk = completedLeg?.type == SegmentType.walk;
    final walkElapsed = completedWalk
        ? journey.walkElapsed + now.difference(journey.currentLegStartedAt)
        : journey.walkElapsed;
    final lastWalkEndedAt = completedWalk ? now : journey.lastWalkEndedAt;
    state = state.copyWith(
      journey: journey.copyWith(
        currentLegIndex: clamped,
        currentLegStartedAt: now,
        walkElapsed: walkElapsed,
        lastWalkEndedAt: lastWalkEndedAt,
      ),
      journeyManualCompletionAvailable: false,
      // 新しい区間はまだ handoff していない。geometry 欠落区間の手動完了は起動/復帰後まで
      // 出さない（前区間完了の直後に次区間を1タップで飛ばさせない）。
      journeyCurrentLegHandedOff: false,
    );
    // 全区間完了（番兵値）へ初めて到達した行程だけを HealthKit へ記録する。歩数は
    // 行程開始からの当日累計差分（外部 Google Maps 中の増分を含む）。期間は徒歩区間の
    // 実経過時間ぶんを、最後の徒歩区間の終了時刻を終点として配置する（電車のあとの徒歩は
    // 時系列上の実位置に置く）。徒歩を1つも完了していない（電車・バスのみの）行程は
    // lastWalkEndedAt が null のまま書き込まない（乗車中の紛れ歩数で0分ワークアウトを
    // 作らない）。journey がリセット（新規検索・代替案選択・失効）で消える経路はここを
    // 通らないため、放棄した行程は完走として記録されない。
    if (writeWorkoutOnCompletion &&
        clamped == route.segments.length &&
        previous < route.segments.length &&
        // 基準歩数が未確定のまま始まった行程は差分が過大になるため書き込まない
        // （nav セッションの _maybeWriteWorkout と同じガード）。
        journey.startBaselineValid &&
        lastWalkEndedAt != null) {
      _writeWorkout(
        start: lastWalkEndedAt.subtract(walkElapsed),
        end: lastWalkEndedAt,
        steps: state.todaySteps - journey.startSteps,
      );
    }
  }

  /// アプリがフォアグラウンド復帰したときに now 経路の時刻を再検証する（#264）。
  /// 結果表示中・ホーム退避中の失効経路は無効化して再検索を促す（メモリに残った失効
  /// 経路を掃除し、ホームの出発時刻の追従も回復させる）。ナビ中は歩行を中断させない
  /// ため無効化しない。経路を表示中は前提時刻とズレるため出発を書き換えない。
  ///
  /// 失効判定は routeAsOf（経路メタデータ）に依存する [isNowRouteExpired] に委ね、現在の
  /// 出発フォームでは分岐しない。固定出発から始めたナビのリルート経路（now 基準）も、
  /// フォームが isNow=false のまま失効させられるようにするため。
  Future<void> onAppResumed() async {
    final now = _now();
    final onExpirableScreen =
        state.screen == Screen.result || state.screen == Screen.home;
    // 進行中の区間を持つ行程だけは失効しても経路を落とさない。5分超の徒歩区間を
    // 外部地図で歩く間に必ず猶予を超過するため、ここで無効化すると歩行中の行程が消えて
    // ホームへ戻される。ナビ中に失効させない既存例外（_reevaluateJourneyLeg が nav を
    // スキップするのと同じ理屈）に揃え、区間再評価へ進める。全区間完了済み（番兵値で
    // legAt が null）の行程は保護すべき handoff が無く、猶予切れの経路を掃除させないと
    // ホームへ戻れないため、行程を持たない result/home と同じく失効させる。
    final journey = state.journey;
    final route = state.route;
    final hasActiveJourneyLeg =
        journey != null &&
        route != null &&
        legAt(route, journey.currentLegIndex) != null;
    if (!hasActiveJourneyLeg &&
        onExpirableScreen &&
        state.isNowRouteExpired(now)) {
      _expireRoute(now);
      return;
    }
    _refreshNowDeparture();
    // 外部地図から result ハブへ戻った行程だけ、handoff 開始後の歩数反映を使う。
    // 起動中に既に届いた更新は保持し、位置取得より後着する場合も Workout 確定を待たせる。
    Completer<_JourneyActivityCatchUpResult>? activityCatchUp;
    int? resumeGeneration;
    // 現在区間を外部地図へ handoff した後の復帰だけ再評価する。前区間完了直後で
    // まだ起動していない区間は、ロック・バックグラウンド復帰で到着判定を走らせない
    // （未起動の区間を自動完了・手動完了で飛ばさせない）。
    if (state.journey != null &&
        state.screen == Screen.result &&
        state.journeyCurrentLegHandedOff) {
      state = state.copyWith(journeyManualCompletionAvailable: false);
      final route = state.route!;
      final journey = state.journey!;
      activityCatchUp =
          _matchingResumeActivityCatchUp(route, journey) ??
          _startResumeActivityCatchUp(route, journey);
      resumeGeneration = ++_journeyResumeGeneration;
    }
    await _reevaluateJourneyLeg(
      activityCatchUp: activityCatchUp,
      resumeGeneration: resumeGeneration,
    );
  }

  /// [route]/[journey] の復帰で開始した歩数更新だけを返す。完了済みの Future も保持し、
  /// 復帰処理より先に歩数が追いついた場合は手動完了を待たせず正しい値で確定する。
  Completer<_JourneyActivityCatchUpResult>? _matchingResumeActivityCatchUp(
    RoutePlan route,
    JourneyProgress journey,
  ) {
    final catchUpJourney = _resumeActivityCatchUpJourney;
    if (!identical(_resumeActivityCatchUpRoute, route) ||
        catchUpJourney == null ||
        catchUpJourney.startedAt != journey.startedAt ||
        catchUpJourney.startSteps != journey.startSteps ||
        catchUpJourney.startBaselineValid != journey.startBaselineValid) {
      return null;
    }
    return _resumeActivityCatchUp;
  }

  /// 復帰／handoff セッションの中断シグナル（完了待ちを打ち切る Completer）を張り替える。
  /// 保留中の徒歩同期一覧は同じ行程のものなので消さず、古い完了待ちだけを superseded で
  /// 終わらせて世代を進める。
  Completer<_JourneyActivityCatchUpResult> _startResumeActivityCatchUp(
    RoutePlan route,
    JourneyProgress journey,
  ) {
    final old = _resumeActivityCatchUp;
    if (old != null && !old.isCompleted) {
      old.complete(_JourneyActivityCatchUpResult.superseded);
    }
    _journeyResumeGeneration++;
    final activityCatchUp = Completer<_JourneyActivityCatchUpResult>();
    _resumeActivityCatchUp = activityCatchUp;
    _resumeActivityCatchUpRoute = route;
    _resumeActivityCatchUpJourney = journey;
    return activityCatchUp;
  }

  /// 徒歩区間 [legIndex] の歩数到着待ちを一覧へ登録する。電車・バス区間は歩数を生まない
  /// ため登録しない。同じ区間が既に登録済みなら基準を巻き戻さない（閾値外で復帰して同じ
  /// 区間を再 handoff しても、歩き切った歩数を捨てないため）。
  void _ensurePendingWalkCatchUp(RoutePlan route, int legIndex) {
    if (legAt(route, legIndex)?.type != SegmentType.walk) return;
    if (_pendingWalkCatchUps.any((c) => c.legIndex == legIndex)) return;
    _pendingWalkCatchUps.add((
      legIndex: legIndex,
      startSteps: state.todaySteps,
    ));
  }

  /// 保留中の全徒歩区間の歩数が十分反映されたか。前の徒歩が未了のまま次区間へ進んだ場合も
  /// 両方を検査し、先に前区間だけ追いついても現在区間の歩数を取りこぼして早期完了しない。
  /// 保留が無ければ（電車・バスのみ到達）待つ意味がないため true。
  bool _hasJourneyActivityCaughtUp() {
    final route = _resumeActivityCatchUpRoute;
    if (route == null) return false;
    if (_pendingWalkCatchUps.isEmpty) return true;
    return _pendingWalkCatchUps.every((c) => _walkCatchUpSettled(route, c));
  }

  /// 徒歩区間 [c] の handoff 後歩数が閾値に達したか。到着自体は位置確認・手動操作で
  /// 確定済みなので、計画距離の半分を同期根拠とし、経路短縮や pedometer の過少計測で
  /// 正しい Workout を捨てすぎないようにする。
  bool _walkCatchUpSettled(
    RoutePlan route,
    ({int legIndex, int startSteps}) c,
  ) {
    final leg = legAt(route, c.legIndex);
    if (leg == null || leg.type != SegmentType.walk) return true;
    final handoffSteps = state.todaySteps - c.startSteps;
    if (handoffSteps <= 0) return false;
    final plannedKm = leg.km ?? 0;
    final plannedThresholdKm =
        plannedKm * _journeyActivityCatchUpMinLegDistanceRatio;
    final flooredKm = plannedThresholdKm < _journeyActivityCatchUpMinDistanceKm
        ? _journeyActivityCatchUpMinDistanceKm
        : plannedThresholdKm;
    // 下限（50m）が計画区間距離より長いと、区間を歩き切っても届かず同期不能になる。
    // 駅出口すぐの数十m徒歩などでは計画距離で頭打ちにし、全歩数が来れば確定できるようにする。
    // ただし計画距離が不明（geometry 欠落で km=0）の区間で 0 まで潰すと、乗車中の紛れ
    // 歩数1歩で即時に同期成立し、後着する実歩数を待たず早期確定してしまう。距離が取れる
    // ときだけ頭打ちにし、不明なときは下限を維持する。
    final requiredKm = plannedKm > 0 && flooredKm > plannedKm
        ? plannedKm
        : flooredKm;
    return ActivitySnapshot.fromSteps(handoffSteps).km >= requiredKm;
  }

  /// 保持中の復帰歩数同期を無効化する。新しい行程・結果ハブ離脱では、以前の行程や復帰
  /// 処理が後着して現在の進捗へ適用されないよう参照も破棄し、保留中の徒歩同期も一掃する。
  void _supersedeResumeActivityCatchUp() {
    _journeyResumeGeneration++;
    final activityCatchUp = _resumeActivityCatchUp;
    if (activityCatchUp != null && !activityCatchUp.isCompleted) {
      activityCatchUp.complete(_JourneyActivityCatchUpResult.superseded);
    }
    _resumeActivityCatchUp = null;
    _resumeActivityCatchUpRoute = null;
    _resumeActivityCatchUpJourney = null;
    _pendingWalkCatchUps.clear();
    _walkTimerLegIndex = null;
  }

  /// 自動到着・手動完了で共有する区間進行処理。最終区間かつ HealthKit 記録が有効で、
  /// handoff した徒歩区間の歩数がまだ追いついていなければ、活動更新を上限付きで待つ。
  /// 電車・バスだけを handoff した場合や追いつき済みの場合は現在値で確定する。
  /// 待機中に画面・経路・区間が変わった場合は古い操作を適用せず、徒歩区間で更新が
  /// 来なかった場合は行程だけ完了して不正確な Workout を捨てる。
  Future<void> _advanceJourneyLegAfterActivityCatchUp({
    required RoutePlan expectedRoute,
    required JourneyProgress expectedJourney,
    Completer<_JourneyActivityCatchUpResult>? activityCatchUp,
    int? expectedResumeGeneration,
  }) async {
    final isFinalLeg =
        expectedJourney.currentLegIndex == expectedRoute.segments.length - 1;
    final healthKitEnabled =
        ref.read(settingsProvider).value?.healthKitEnabled ?? false;
    final shouldWaitForActivity =
        isFinalLeg &&
        activityCatchUp != null &&
        expectedJourney.startBaselineValid &&
        healthKitEnabled &&
        !_hasJourneyActivityCaughtUp();
    var activityCaughtUp = true;
    if (shouldWaitForActivity) {
      // 最初の歩数イベントは部分値の可能性があるため、それだけで早期完了しない。
      // 同期猶予を最後まで使って state に反映された最新値を評価し、新しい handoff や
      // 画面離脱で置き換えられた場合だけ待機を途中終了する。
      final catchUpResult = await Future.any([
        activityCatchUp.future,
        Future.delayed(
          _journeyActivityCatchUpTimeout,
          () => _JourneyActivityCatchUpResult.settled,
        ),
      ]);
      if (catchUpResult == _JourneyActivityCatchUpResult.superseded) return;
      activityCaughtUp = _hasJourneyActivityCaughtUp();
    }
    if (_disposed) return;

    final journeyNow = state.journey;
    if ((activityCatchUp != null &&
            !identical(_resumeActivityCatchUp, activityCatchUp)) ||
        (expectedResumeGeneration != null &&
            expectedResumeGeneration != _journeyResumeGeneration) ||
        state.screen != Screen.result ||
        !identical(state.route, expectedRoute) ||
        !identical(journeyNow, expectedJourney)) {
      return;
    }
    _advanceToLeg(
      expectedJourney.currentLegIndex + 1,
      writeWorkoutOnCompletion: activityCaughtUp,
    );
  }

  /// 復帰時に現在地を単発再取得し、現在区間の終点へ到着していれば行程を 1 区間だけ
  /// 進める（#305）。「近くにいる」だけで複数区間を一気に進めないよう、到着していても
  /// 進めるのは 1 つまで（次区間の終点にも近い場合でも 1 区間）。現在地取得に失敗
  /// （Denied/Unavailable）した場合や、取得位置が到着閾値外だった場合は自動完了せず、
  /// 手動完了へフォールバックする。
  ///
  /// journey が無ければ再評価しない（#264 の失効検査のみ）。result ハブ以外では
  /// 行程を画面に表示していないため、非表示の進捗更新やWorkout書き込みを避けて走らせない。
  Future<void> _reevaluateJourneyLeg({
    Completer<_JourneyActivityCatchUpResult>? activityCatchUp,
    int? resumeGeneration,
  }) async {
    final journey = state.journey;
    final route = state.route;
    if (journey == null || route == null || state.screen != Screen.result) {
      return;
    }
    if (legAt(route, journey.currentLegIndex) == null) return;
    // 現在区間を handoff していなければ到着判定しない。前区間完了直後の未起動区間を、
    // 端末ロック等の復帰で自動完了・手動完了へ進めさせないため。
    if (!state.journeyCurrentLegHandedOff) return;

    final result = await _fetchLocation();
    if (_disposed ||
        resumeGeneration != _journeyResumeGeneration ||
        state.screen != Screen.result ||
        !identical(state.route, route) ||
        !identical(state.journey, journey)) {
      return;
    }
    if (result is! LocationAvailable) {
      state = state.copyWith(journeyManualCompletionAvailable: true);
      return;
    }
    // async gap 中に失効・リセット・別の復帰で journey/route が変わり得るため再取得する。
    final journeyNow = state.journey;
    final routeNow = state.route;
    if (journeyNow == null || routeNow == null) return;
    final leg = legAt(routeNow, journeyNow.currentLegIndex);
    if (leg == null) return;
    if (isLegArrived(leg: leg, current: result.position)) {
      await _advanceJourneyLegAfterActivityCatchUp(
        expectedRoute: routeNow,
        expectedJourney: journeyNow,
        activityCatchUp: activityCatchUp,
        expectedResumeGeneration: resumeGeneration,
      );
    } else {
      state = state.copyWith(journeyManualCompletionAvailable: true);
    }
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
