import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/route_plan.dart';
import '../models/time_value.dart';

enum Screen { onboarding, home, search, loading, result, nav }

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
    required this.departure,
    required this.arrival,
    required this.picker,
    required this.route,
  });

  final Screen screen;
  final String? destination;
  final TimeValue departure;
  final TimeValue arrival;
  final PickerState? picker;
  final RoutePlan? route;

  int get budgetMinutes => arrival.totalMinutes - departure.totalMinutes;

  AppState copyWith({
    Screen? screen,
    Object? destination = _sentinel,
    TimeValue? departure,
    TimeValue? arrival,
    Object? picker = _sentinel,
    Object? route = _sentinel,
  }) {
    return AppState(
      screen: screen ?? this.screen,
      destination: identical(destination, _sentinel)
          ? this.destination
          : destination as String?,
      departure: departure ?? this.departure,
      arrival: arrival ?? this.arrival,
      picker: identical(picker, _sentinel)
          ? this.picker
          : picker as PickerState?,
      route: identical(route, _sentinel) ? this.route : route as RoutePlan?,
    );
  }

  static const _sentinel = Object();

  static const initial = AppState(
    screen: Screen.onboarding,
    destination: '渋谷ヒカリエ',
    departure: TimeValue(h: 9, m: 32, isNow: true, anchored: true),
    arrival: TimeValue(h: 10, m: 50),
    picker: null,
    route: null,
  );
}

class AppNotifier extends Notifier<AppState> {
  @override
  AppState build() => AppState.initial;

  void go(Screen s) => state = state.copyWith(screen: s);

  void setDestination(String? d) => state = state.copyWith(destination: d);

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
    state = state.copyWith(screen: Screen.loading);
    await Future<void>.delayed(const Duration(milliseconds: 1800));
    state = state.copyWith(screen: Screen.result, route: RoutePlan.mock);
  }

  static int _roundTo5(int m) {
    final rounded = ((m + 2) ~/ 5) * 5;
    return rounded.clamp(0, 55);
  }
}

final appStateProvider = NotifierProvider<AppNotifier, AppState>(
  AppNotifier.new,
);
