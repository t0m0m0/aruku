import { useEffect, useMemo, useRef } from 'react';
import {
  APILoadingStatus,
  APIProvider,
  Map,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';

import type { RoutePlan } from '@aruku/engine/models/route-plan';

import { appConfig } from '../config';
import { arukuWakabaMapStyle } from './map-style';
import type { LatLng, RouteBounds, RouteOverlayPath } from './route-overlays';
import { boundsEqual, toBounds, toEndpoints, toOverlayPaths } from './route-overlays';
import { StylizedMap } from './stylized-map';

const defaultCenter = { lat: 35.6679, lng: 139.7038 };
const defaultZoom = 14;

const fitPadding = 48;

interface ArukuMapProps {
  route?: RoutePlan | null;
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

function RealMapWhenLoaded({ route, showRoute }: { route: RoutePlan | null; showRoute: boolean }) {
  const status = useApiLoadingStatus();

  if (status !== APILoadingStatus.LOADED) {
    return <StylizedMap showRoute={showRoute} />;
  }

  return (
    <Map
      className="size-full"
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

  const paths = useMemo(() => toOverlayPaths(route), [route]);
  const endpoints = useMemo(() => toEndpoints(route), [route]);
  const bounds = useMemo(() => toBounds(route), [route]);

  useRoutePaths(map, paths);
  useRouteEndpoints(map, endpoints);
  useFitBounds(map, bounds);

  return null;
}

export function useFitBounds(map: google.maps.Map | null, bounds: RouteBounds | null) {
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
    const drawn = paths.map((path) => new google.maps.Polyline(toPolylineOptions(path, map)));
    return () => {
      for (const polyline of drawn) polyline.setMap(null);
    };
  }, [map, paths]);
}

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

function useRouteEndpoints(
  map: google.maps.Map | null,
  endpoints: { start: LatLng; end: LatLng } | null,
) {
  const markerLibrary = useMapsLibrary('marker');

  useEffect(() => {
    if (map === null || endpoints === null || markerLibrary === null) return;
    const markers = [
      new markerLibrary.Marker({
        map,
        position: endpoints.start,
        icon: endpointIcon('#4F9527'),
      }),
      new markerLibrary.Marker({
        map,
        position: endpoints.end,
        icon: endpointIcon('#F08338'),
      }),
    ];
    return () => {
      for (const marker of markers) marker.setMap(null);
    };
  }, [map, endpoints, markerLibrary]);
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
