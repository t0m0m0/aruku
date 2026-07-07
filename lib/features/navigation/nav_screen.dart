import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/models/geo_point.dart';
import '../../core/models/location_state.dart';
import '../../core/models/route_plan.dart';
import '../../core/navigation/nav_engine.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/aruku_theme.dart';
import '../../l10n/app_localizations.dart';
import '../../shared/extensions/route_map_overlays.dart';
import '../../shared/icons/ic.dart';
import '../../shared/widgets/aruku_button.dart';
import '../../shared/widgets/aruku_card.dart';
import '../../shared/widgets/aruku_map.dart';
import 'nav_marker_icon.dart';

part 'nav_widgets.dart';

/// ナビ視点（zoom17/tilt45）を維持したまま [pos] を中心とするカメラ位置。
CameraPosition navCameraPosition(GeoPoint pos) => CameraPosition(
  target: LatLng(pos.lat, pos.lng),
  zoom: ArukuMapVariant.nav.zoom,
  tilt: ArukuMapVariant.nav.tilt,
);

/// 現在地マーカーを組み立てる。headingが取得できていて進行方向つきアイコン
/// ([directionalIcon]、円形・中心アンカー)の読込も済んでいればそれを使い
/// 回転させる。どちらか未確定なら既存の涙型ピン（先端＝下端がアンカー）に
/// フォールバックするため、アンカーもアイコンの形状に合わせて出し分ける。
Marker currentLocationMarker({
  required GeoPoint current,
  required BitmapDescriptor? directionalIcon,
}) {
  final usesDirectionalIcon =
      current.heading != null && directionalIcon != null;
  return Marker(
    markerId: const MarkerId('current'),
    position: LatLng(current.lat, current.lng),
    icon: usesDirectionalIcon
        ? directionalIcon
        : BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
    rotation: current.heading ?? 0,
    flat: current.heading != null,
    anchor: usesDirectionalIcon
        ? const Offset(0.5, 0.5)
        : const Offset(0.5, 1.0),
  );
}

class NavScreen extends ConsumerStatefulWidget {
  const NavScreen({super.key});

  @override
  ConsumerState<NavScreen> createState() => _NavScreenState();
}

class _NavScreenState extends ConsumerState<NavScreen> {
  GoogleMapController? _mapController;
  MapType _mapType = MapType.normal;

  /// 直前フレームでのポリライン沿い累積距離（メートル）。自己交差・並走
  /// 区間でのスナップジャンプを防ぐため [computeGuidance] へ渡す。
  /// 経路が変わったら（再検索等）無効なので破棄する。
  double? _lastDistanceAlongMeters;
  RoutePlan? _lastRouteForDistance;

  /// GPS更新にカメラを追従させるかどうか。ユーザーが地図を操作すると解除される。
  bool _autoFollow = true;

  /// こちらから `animateCamera` を呼んだ移動がまだ収まっていないかどうか。
  /// `animateCamera` の返す Future はプラットフォーム呼び出しの ack で完了し、
  /// アニメーション終了（＝`onCameraIdle`）より先に完了しうるため、
  /// このフラグは await ではなく `onCameraIdle` で解除する。
  /// `onCameraMoveStarted` はプログラム由来の移動でも発火するため、
  /// ユーザー操作由来かどうかをこのフラグで判別する。
  bool _isProgrammaticCamera = false;

  /// 進行方向つき現在地マーカーのアイコン。生成が非同期のため、完了までは
  /// 従来の汎用ピンにフォールバックする。
  BitmapDescriptor? _directionalMarkerIcon;

  /// 歩行完了（完了画面への遷移）を一度だけ発火させるためのガード。
  /// 到着の自動検出・手動完了のどちらから呼ばれても二重遷移しない。
  bool _completed = false;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();
    // フォールバックの defaultMarkerWithHue(hueAzure) と色味を揃える。
    final azure = const HSVColor.fromAHSV(
      1.0,
      BitmapDescriptor.hueAzure,
      1.0,
      1.0,
    ).toColor();
    buildDirectionalMarkerIcon(color: azure).then((icon) {
      if (!mounted) return;
      setState(() => _directionalMarkerIcon = icon);
    });
  }

  @override
  void dispose() {
    WakelockPlus.disable();
    super.dispose();
  }

  void _animateCamera(CameraUpdate update) {
    final controller = _mapController;
    if (controller == null) return;
    _isProgrammaticCamera = true;
    controller.animateCamera(update);
  }

  void _onCameraMoveStarted() {
    if (_isProgrammaticCamera || !_autoFollow) return;
    setState(() => _autoFollow = false);
  }

  void _onCameraIdle() {
    _isProgrammaticCamera = false;
  }

  /// 「現在地に戻る」: 追従を再開し、即座に現在地へカメラを寄せる。
  void _recenter() {
    final pos = ref.read(appStateProvider).currentPosition;
    if (pos == null) return;
    setState(() => _autoFollow = true);
    _animateCamera(CameraUpdate.newCameraPosition(navCameraPosition(pos)));
  }

  /// 「ナビを終了しますか？」確認ダイアログ。終了が選ばれた場合のみ true を返す。
  Future<bool> _confirmEndNav() async {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(l10n.navConfirmExitTitle),
        actions: [
          TextButton(
            key: const Key('nav-exit-cancel-button'),
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.pickerCancel),
          ),
          TextButton(
            key: const Key('nav-exit-confirm-button'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(l10n.navExit, style: TextStyle(color: c.danger)),
          ),
        ],
      ),
    );
    return confirmed ?? false;
  }

  Future<void> _handleExitRequested() async {
    final confirmed = await _confirmEndNav();
    if (!mounted || !confirmed) return;
    ref.read(appStateProvider.notifier).go(Screen.home);
  }

  /// 到着とみなす残り距離（km）。ほぼ終点（約8m以内）に達したら完了画面へ遷移する。
  /// 「まもなく到着」案内を出す手前で誤発火しないよう実到着相当まで絞り、
  /// GPS 誤差で自動発火しない場合は「歩き終わった」ボタンを導線とする。
  static const double _arriveRemainingKm = 0.008;

  /// 歩行完了サマリーを確定し完了画面へ遷移する。到着自動検出と手動完了の
  /// 双方の入口。実際に歩いた徒歩距離（電車区間を除く）と消費 kcal を渡す。
  void _finishWalk(NavGuidance guidance, RoutePlan route) {
    if (_completed) return;
    _completed = true;
    final walkedKm = (route.walkKm - guidance.remainingWalkKm).clamp(
      0.0,
      route.walkKm,
    );
    ref
        .read(appStateProvider.notifier)
        .finishWalk(
          distanceKm: walkedKm,
          kcal: guidance.consumedKcal,
          from: route.from,
          to: route.to,
        );
  }

  void _toggleLayer() {
    setState(() {
      _mapType = _mapType == MapType.normal ? MapType.hybrid : MapType.normal;
    });
  }

  /// コンパス: 現在地を中心に北向き（bearing 0）へ戻す。
  void _resetNorth() {
    final pos = ref.read(appStateProvider).currentPosition;
    if (pos == null) return;
    _animateCamera(CameraUpdate.newCameraPosition(navCameraPosition(pos)));
  }

  /// ルート全体俯瞰フィット完了後、現在地が既にあればナビ視点へ切り替える。
  void _snapToNavCamera(GoogleMapController controller) {
    final pos = ref.read(appStateProvider).currentPosition;
    if (pos == null) return;
    _animateCamera(CameraUpdate.newCameraPosition(navCameraPosition(pos)));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(appStateProvider);
    final route = state.route;
    final current = state.currentPosition;

    // 実移動に追従して地図カメラを現在地へ寄せる（追従中のみ）。
    ref.listen(appStateProvider.select((s) => s.currentPosition), (_, next) {
      if (next != null && _autoFollow) {
        _animateCamera(CameraUpdate.newCameraPosition(navCameraPosition(next)));
      }
    });

    if (route != _lastRouteForDistance) {
      _lastRouteForDistance = route;
      _lastDistanceAlongMeters = null;
    }
    final guidance = (route != null && current != null)
        ? computeGuidance(
            route: route,
            current: current,
            previousDistanceAlongMeters: _lastDistanceAlongMeters,
          )
        : null;
    if (guidance != null) {
      _lastDistanceAlongMeters = guidance.traveledKm * 1000;
    }

    // 到着（残り距離が閾値以下）を検出したら、フレーム後に完了画面へ遷移する。
    // build 中に state を変更しないよう postFrame にずらし、_completed で一度だけ発火。
    if (guidance != null &&
        route != null &&
        !_completed &&
        guidance.remainingKm <= _arriveRemainingKm) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _finishWalk(guidance, route);
      });
    }

    final totalKm = guidance?.totalKm ?? route?.totalKm ?? 0.0;
    final markers = <Marker>{
      if (route != null) ...route.toMarkers(),
      if (current != null)
        currentLocationMarker(
          current: current,
          directionalIcon: _directionalMarkerIcon,
        ),
    };

    // 案内カード・下部バーは固定サイズの地図オーバーレイのため、無制限な文字
    // 拡大だとオーバーフローする。読みやすさは確保しつつ上限でクランプする。
    final clampedTextScaler = MediaQuery.textScalerOf(
      context,
    ).clamp(maxScaleFactor: 1.3);

    return MediaQuery(
      data: MediaQuery.of(context).copyWith(textScaler: clampedTextScaler),
      child: PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, result) async {
          if (didPop) return;
          await _handleExitRequested();
        },
        child: Material(
          color: c.mapBg,
          child: Stack(
            children: [
              // Full-bleed map
              Positioned.fill(
                child: ArukuMap(
                  variant: ArukuMapVariant.nav,
                  polylines: route?.toPolylines() ?? const {},
                  markers: markers,
                  routeBounds: route?.toBounds(),
                  mapType: _mapType,
                  onMapReady: (controller) => _mapController = controller,
                  onFitBoundsComplete: _snapToNavCamera,
                  onCameraMoveStarted: _onCameraMoveStarted,
                  onCameraIdle: _onCameraIdle,
                ),
              ),

              SafeArea(
                child: Stack(
                  children: [
                    Column(
                      children: [
                        // Top instruction card
                        Padding(
                          padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
                          child: _InstructionCard(
                            guidance: guidance,
                            destination: route?.to,
                          ),
                        ),
                        if (state.locationState is LocationUnavailable)
                          const Padding(
                            padding: EdgeInsets.fromLTRB(12, 8, 12, 0),
                            child: _GpsLostBanner(),
                          ),
                        if (state.isRerouting)
                          const Padding(
                            padding: EdgeInsets.fromLTRB(12, 8, 12, 0),
                            child: _RerouteBanner(),
                          )
                        else if (state.rerouteFailed)
                          const Padding(
                            padding: EdgeInsets.fromLTRB(12, 8, 12, 0),
                            child: _RerouteFailedBanner(),
                          ),
                        const Spacer(),
                        if (!_autoFollow)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: ArukuButton(
                              key: const Key('nav-recenter-button'),
                              label: l10n.navRecenterButton,
                              onPressed: _recenter,
                              icon: Ic.locate(size: 16, color: c.ivory),
                              iconGap: 8,
                              fullWidth: false,
                              height: 44,
                              borderRadius: 22,
                              backgroundColor: c.moss700,
                              textStyle: jpStyle(
                                size: 13,
                                weight: FontWeight.w800,
                                color: c.ivory,
                                letterSpacing: 0.06 * 13,
                              ),
                            ),
                          ),
                        // 「歩き終わった」手動完了ボタン。到着自動検出が GPS 誤差で
                        // 発火しない場合の導線として常時提示する。
                        if (guidance != null && route != null)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: ArukuButton(
                              key: const Key('nav-finish-button'),
                              label: l10n.navFinishButton,
                              onPressed: () => _finishWalk(guidance, route),
                              icon: Ic.flag(size: 16, color: c.ivory),
                              iconGap: 8,
                              fullWidth: false,
                              height: 44,
                              borderRadius: 22,
                              backgroundColor: c.burnt,
                              textStyle: jpStyle(
                                size: 13,
                                weight: FontWeight.w800,
                                color: c.ivory,
                                letterSpacing: 0.06 * 13,
                              ),
                            ),
                          ),
                        // Bottom stats bar
                        Padding(
                          padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
                          child: _StatsBar(
                            traveledKm: guidance?.traveledKm ?? 0.0,
                            totalKm: totalKm,
                            progress: guidance?.progress ?? 0.0,
                            remainingKm: guidance?.remainingKm ?? totalKm,
                            remainingWalkKm:
                                guidance?.remainingWalkKm ??
                                route?.walkKm ??
                                totalKm,
                            arrivalTime: guidance != null
                                ? _formatArrival(guidance.etaMinutesRemaining)
                                : null,
                            consumedKcal: guidance?.consumedKcal,
                            onExit: _handleExitRequested,
                          ),
                        ),
                      ],
                    ),

                    // Right controls: 案内カード（可変長）の下に固定オフセットで配置。
                    Positioned(
                      right: 12,
                      top: 96,
                      child: Column(
                        children: [
                          _NavChip(
                            key: const Key('nav-layer-chip'),
                            icon: Ic.layers(size: 20, color: c.ink2),
                            onTap: _toggleLayer,
                            semanticLabel: l10n.navToggleMapType,
                          ),
                          const SizedBox(height: 8),
                          _NavChip(
                            key: const Key('nav-compass-chip'),
                            icon: Ic.compass(size: 20, color: c.ink2),
                            onTap: _resetNorth,
                            semanticLabel: l10n.navResetNorth,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 現在時刻に残り分を足した到着予定時刻を "HH:mm" で返す。
String _formatArrival(int minutesRemaining) {
  final t = DateTime.now().add(Duration(minutes: minutesRemaining));
  return '${t.hour.toString().padLeft(2, '0')}:'
      '${t.minute.toString().padLeft(2, '0')}';
}
