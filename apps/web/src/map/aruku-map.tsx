// 移植元: lib/shared/widgets/aruku_map.dart
//
// variant は運んでいない。移植元の nav / thumb はどこからも指定されておらず（全 3 箇所が
// 既定の full）、寄り視点を使う nav 画面は Web に無い。連れてくると、使われない分岐の
// ぶんだけ「この画面はどの variant か」を読む側が考えることになる。
//
// Maps JS API の読み込み待ち（maps_js_loader.dart の mapsJsLoadedProvider）は形を変えて
// 残してある。スクリプトを読みに行くのは APIProvider がやるが、読めるまでの間と読めなかった
// ときに代わりの絵を出すところまでは持たない——素通しにすると、その間 result のプレビューと
// loading の背景が空白になる。移植元の supportsRealMap と同じく、読み込みが済むまでは
// 作り物の地図を描き続ける。

import { useEffect, useMemo, useRef } from 'react';
import {
  APILoadingStatus,
  APIProvider,
  Map,
  useApiLoadingStatus,
  useMap,
} from '@vis.gl/react-google-maps';

import type { RoutePlan } from '@aruku/engine/models/route-plan';

import { appConfig } from '../config';
import { arukuWakabaMapStyle } from './map-style';
import type { LatLng, RouteBounds, RouteOverlayPath } from './route-overlays';
import { boundsEqual, toBounds, toEndpoints, toOverlayPaths } from './route-overlays';
import styles from './aruku-map.module.css';
import { StylizedMap } from './stylized-map';

/// 渋谷駅付近（デザインの基準エリア）。経路が無いときの初期位置。
const defaultCenter = { lat: 35.6679, lng: 139.7038 };
const defaultZoom = 14;

/// 移植元 _fitBounds の full variant のパディング。
const fitPadding = 48;

interface ArukuMapProps {
  route?: RoutePlan | null;
  /// 作り物の地図に経路を描くか。実地図では [route] の有無が決めるので効かない。
  showRoute?: boolean;
  apiKey?: string;
}

export function ArukuMap({
  route = null,
  showRoute = true,
  apiKey = appConfig.mapsApiKey,
}: ArukuMapProps) {
  if (apiKey === '') return <StylizedMap showRoute={showRoute} />;

  return (
    <APIProvider apiKey={apiKey}>
      <RealMapWhenLoaded route={route} showRoute={showRoute} />
    </APIProvider>
  );
}

/// 読み込みが済むまで——そして済まなかったときはずっと——作り物の地図を描く。
///
/// FAILED はスクリプト自体を取れなかったとき（オフライン・CSP による遮断）。AUTH_FAILURE は
/// ライブラリが型に持つだけで、1.10.0 は**どこからも設定しない**（遷移するのは LOADING /
/// LOADED / FAILED の3つ）。将来出るようになったときに素通ししないよう、LOADED 以外は
/// まとめて作り物の地図へ倒している。
///
/// 逆に、**キーが無効・制限違反のときはここへ来ない**。スクリプトは正常に読めるので状態は
/// LOADED になり、Google が地図の中へ自前のエラー面（「このページでは Google マップが
/// 正しく読み込まれませんでした」）を描く。こちらから見分ける術は無く、DOM を覗いて
/// 当てにいく価値も無い——リファラー制限の設定は docs/security_hardening.md の側の話。
function RealMapWhenLoaded({
  route,
  showRoute,
}: {
  route: RoutePlan | null;
  showRoute: boolean;
}) {
  const status = useApiLoadingStatus();

  if (status !== APILoadingStatus.LOADED) {
    return <StylizedMap showRoute={showRoute} />;
  }

  return (
    <Map
      className={styles.map}
      defaultCenter={defaultCenter}
      defaultZoom={defaultZoom}
      styles={arukuWakabaMapStyle}
      disableDefaultUI={true}
    >
      {route === null ? null : <RouteOverlays route={route} />}
    </Map>
  );
}

function RouteOverlays({ route }: { route: RoutePlan }) {
  const map = useMap();

  // 経路から起こした図形は route が変わったときだけ作り直す。毎描画で作り直すと、
  // 参照で依存を見ている下の effect が地図を消して描き直し続ける。
  const paths = useMemo(() => toOverlayPaths(route), [route]);
  const endpoints = useMemo(() => toEndpoints(route), [route]);
  const bounds = useMemo(() => toBounds(route), [route]);

  useRoutePaths(map, paths);
  useRouteEndpoints(map, endpoints);
  useFitBounds(map, bounds);

  return null;
}

/// 経路全体が収まるようカメラを合わせる。
///
/// 矩形を**値で**比べる。代替案の切り替えで route は毎回作り直され、そこから計算した
/// 矩形も新しいオブジェクトになる——参照で見ると同じ経路のままカメラが飛ぶ。
export function useFitBounds(
  map: google.maps.Map | null,
  bounds: RouteBounds | null,
) {
  const applied = useRef<RouteBounds | null>(null);

  useEffect(() => {
    if (map === null || bounds === null) return;
    if (boundsEqual(applied.current, bounds)) return;
    applied.current = bounds;
    map.fitBounds(bounds, fitPadding);
  }, [map, bounds]);
}

function useRoutePaths(map: google.maps.Map | null, paths: RouteOverlayPath[]) {
  useEffect(() => {
    if (map === null) return;
    const drawn = paths.map(
      (path) => new google.maps.Polyline(toPolylineOptions(path, map)),
    );
    return () => {
      for (const polyline of drawn) polyline.setMap(null);
    };
  }, [map, paths]);
}

/// 破線は Maps API にプロパティが無く、線を透明にして点線のシンボルを繰り返す。
/// dash/gap の寸法をここで API の言葉へ畳む——route-overlays.ts は Maps API を
/// 知らないままにしておく。
function toPolylineOptions(
  path: RouteOverlayPath,
  map: google.maps.Map,
): google.maps.PolylineOptions {
  const base: google.maps.PolylineOptions = {
    map,
    path: [...path.points],
    strokeColor: path.strokeColor,
    strokeWeight: path.strokeWeight,
  };
  if (path.dash === null) return base;
  return {
    ...base,
    strokeOpacity: 0,
    icons: [
      {
        icon: {
          path: 'M 0,-1 0,1',
          strokeColor: path.strokeColor,
          strokeOpacity: 1,
          strokeWeight: path.strokeWeight,
          scale: path.dash.length / 2,
        },
        offset: '0',
        repeat: `${path.dash.length + path.dash.gap}px`,
      },
    ],
  };
}

/// 始点と終点の印。
///
/// AdvancedMarkerElement ではなく旧 Marker を使う。AdvancedMarker は mapId を要求し、
/// mapId は styles と排他——Wakaba の配色を捨てることになる（map-style.ts 参照）。
///
/// 移植元は BitmapDescriptor.defaultMarkerWithHue の緑／橙で、これは Google の既定ピンを
/// 色相回転したもの。同じ絵は JS 側に無いので、作り物の地図と同じ walk / burnt で描く。
function useRouteEndpoints(
  map: google.maps.Map | null,
  endpoints: { start: LatLng; end: LatLng } | null,
) {
  useEffect(() => {
    if (map === null || endpoints === null) return;
    const markers = [
      new google.maps.Marker({
        map,
        position: endpoints.start,
        icon: endpointIcon('#4F9527'),
      }),
      new google.maps.Marker({
        map,
        position: endpoints.end,
        icon: endpointIcon('#F08338'),
      }),
    ];
    return () => {
      for (const marker of markers) marker.setMap(null);
    };
  }, [map, endpoints]);
}

function endpointIcon(fillColor: string): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 7,
    fillColor,
    fillOpacity: 1,
    strokeColor: '#FFFFFF',
    strokeWeight: 3,
  };
}
