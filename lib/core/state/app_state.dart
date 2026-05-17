import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/geo_point.dart';
import '../models/location_state.dart';
import '../models/route_error.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import '../services/location_service.dart';
import '../services/route_service.dart';

enum Screen { onboarding, home, search, loading, result, nav, error }

@immutable
class PickerState {
  const PickerState({required this.mode, required this.h, required this.m});

  final PickerMode mode;
  final int h;
  final int m;

  PickerState copyWith({PickerMode? mode, int? h, int? m}) =>
      PickerState(mode: mode ?? this.mode, h: h ?? this.h, m: m ?? this.m);
}

@immutable
class AppState {
  const AppState({
    required this.screen,
    required this.destination,
    required this.destinationLatLng,
    required this.departure,
    required this.arrival,
    required this.picker,
    required this.route,
    required this.locationState,
    this.routeErrorKind,
    this.routePhase,
    this.streakDays = 0,
    this.weekKm = 0.0,
    this.todayKm = 0.0,
    this.todayKcal = 0,
  });

  final Screen screen;
  final String? destination;
  final GeoPoint? destinationLatLng;
  final TimeValue departure;
  final TimeValue arrival;
  final PickerState? picker;
  final RoutePlan? route;
  final LocationState locationState;
  final RouteErrorKind? routeErrorKind;
  final RoutePhase? routePhase;
  final int streakDays;
  final double weekKm;
  final double todayKm;
  final int todayKcal;

  int get budgetMinutes => arrival.totalMinutes - departure.totalMinutes;

  String get departureLabelText => switch (locationState) {
    LocationLoading() => '現在地 · 取得中...',
    LocationAvailable() => '現在地',
    LocationDenied() => '位置情報なし',
  };

  AppState copyWith({
    Screen? screen,
    Object? destination = _sentinel,
    Object? destinationLatLng = _sentinel,
    TimeValue? departure,
    TimeValue? arrival,
    Object? picker = _sentinel,
    Object? route = _sentinel,
    LocationState? locationState,
    Object? routeErrorKind = _sentinel,
    Object? routePhase = _sentinel,
    int? streakDays,
    double? weekKm,
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
      departure: departure ?? this.departure,
      arrival: arrival ?? this.arrival,
      picker: identical(picker, _sentinel)
          ? this.picker
          : picker as PickerState?,
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
    picker: null,
    route: null,
    locationState: LocationLoading(),
  );
}

class AppNotifier extends Notifier<AppState> {
  @override
  AppState build() {
    unawaited(_fetchLocation());
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
      state = state.copyWith(locationState: result);
    } catch (_) {
      state = state.copyWith(locationState: const LocationDenied());
    }
  }

  void go(Screen s) => state = state.copyWith(screen: s);

  void setDestination(String? name, {GeoPoint? latLng}) =>
      state = state.copyWith(destination: name, destinationLatLng: latLng);

  void openPicker(PickerMode mode) {
    final src = mode == PickerMode.depart ? state.departure : state.arrival;
    state = state.copyWith(
      picker: PickerState(mode: mode, h: src.h, m: _roundTo5(src.m)),
    );
  }

  void updatePicker({int? h, int? m}) {
    final p = state.picker;
    if (p == null) return;
    state = state.copyWith(
      picker: p.copyWith(h: h, m: m == null ? null : _roundTo5(m)),
    );
  }

  void switchPickerMode(PickerMode mode) {
    final src = mode == PickerMode.depart ? state.departure : state.arrival;
    state = state.copyWith(
      picker: PickerState(mode: mode, h: src.h, m: _roundTo5(src.m)),
    );
  }

  void confirmPicker() {
    final p = state.picker;
    if (p == null) return;
    if (p.mode == PickerMode.depart) {
      state = state.copyWith(
        departure: TimeValue(h: p.h, m: p.m, anchored: true),
        arrival: state.arrival.copyWith(anchored: false),
        picker: null,
      );
    } else {
      state = state.copyWith(
        departure: state.departure.copyWith(anchored: false),
        arrival: TimeValue(h: p.h, m: p.m, anchored: true),
        picker: null,
      );
    }
  }

  void closePicker() => state = state.copyWith(picker: null);

  Future<void> startSearch() async {
    state = state.copyWith(
      screen: Screen.loading,
      routeErrorKind: null,
      routePhase: RoutePhase.routing,
    );
    final origin = switch (state.locationState) {
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
