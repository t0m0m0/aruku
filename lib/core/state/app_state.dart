import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/activity_snapshot.dart';
import '../models/geo_point.dart';
import '../models/location_state.dart';
import '../models/route_error.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import '../services/activity_service.dart';
import '../services/location_service.dart';
import '../services/route_service.dart';

enum Screen {
  onboarding,
  home,
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

  int get budgetMinutes => arrival.totalMinutes - departure.totalMinutes;

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
    return AppState.initial.copyWith(
      departure: TimeValue(h: depH, m: depM, isNow: true, anchored: true),
    );
  }

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

  /// 歩数センサーの権限を要求し、許可されたら活動量を購読して
  /// todaySteps / todayKm / todayKcal を更新する。
  Future<void> _startActivityTracking() async {
    try {
      final service = ref.read(activityServiceProvider);
      if (!await service.requestPermission() || _disposed) return;
      _activitySub = service.sessionActivityStream().listen(
        (snap) {
          if (_disposed) return;
          state = state.copyWith(
            todaySteps: snap.steps,
            todayKm: snap.km,
            todayKcal: snap.kcal,
          );
        },
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
          (p) => state = state.copyWith(currentPosition: p),
          // GPS 喪失や位置サービス停止で流れる一時的なエラーは無視し、
          // 未捕捉例外を防ぐ。最後に取得した現在地を保持する。
          onError: (_) {},
        );
  }

  void _stopTracking() {
    _posSub?.cancel();
    _posSub = null;
    if (state.currentPosition != null) {
      state = state.copyWith(currentPosition: null);
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
