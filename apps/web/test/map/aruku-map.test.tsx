import { render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { RoutePlan, RouteSegment, SegmentType } from '@aruku/engine/models/route-plan';

const mapProps = vi.fn<(props: Record<string, unknown>) => void>();

let currentMap: google.maps.Map | null = null;

let currentStatus = 'LOADED';

let currentMarkerLibrary: unknown = null;

vi.mock('@vis.gl/react-google-maps', () => ({
  APILoadingStatus: {
    NOT_LOADED: 'NOT_LOADED',
    LOADING: 'LOADING',
    LOADED: 'LOADED',
    FAILED: 'FAILED',
    AUTH_FAILURE: 'AUTH_FAILURE',
  },
  useApiLoadingStatus: () => currentStatus,
  useMapsLibrary: (name: string) => (name === 'marker' ? currentMarkerLibrary : null),
  APIProvider: ({ children, apiKey }: { children?: unknown; apiKey: string }) => (
    <div data-testid="api-provider" data-api-key={apiKey}>
      {children as never}
    </div>
  ),
  Map: (props: Record<string, unknown>) => {
    mapProps(props);
    return <div data-testid="google-map">{props.children as never}</div>;
  },
  useMap: () => currentMap,
}));

const { ArukuMap, useFitBounds } = await import('../../src/map/aruku-map');

function route(polyline: GeoPoint[] = [new GeoPoint(35.6, 139.7), new GeoPoint(35.65, 139.75)]) {
  return new RoutePlan({
    from: '新宿駅',
    to: '渋谷駅',
    totalKm: 5.2,
    totalMin: 60,
    budgetMin: 90,
    kcal: 210,
    walkKm: 4.1,
    walkRatio: 0.79,
    segments: [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '新宿駅',
        toName: '渋谷駅',
        minutes: 12,
        polyline,
      }),
    ],
    timelineNodes: [],
  });
}

beforeEach(() => {
  mapProps.mockClear();
  currentMap = null;
  currentStatus = 'LOADED';
  currentMarkerLibrary = null;
});

describe('ArukuMap', () => {
  it('キーが無ければ作り物の地図を描く', () => {
    const { container } = render(<ArukuMap apiKey="" />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('google-map')).toBeNull();
  });

  it('キーが無ければ経路があっても作り物の地図のまま', () => {
    render(<ArukuMap apiKey="" route={route()} />);

    expect(screen.queryByTestId('google-map')).toBeNull();
  });

  it('キーがあれば実地図を描く', () => {
    render(<ArukuMap apiKey="maps-key" />);

    expect(screen.getByTestId('google-map')).toBeDefined();
  });

  it('キーを APIProvider へ渡す', () => {
    render(<ArukuMap apiKey="maps-key" />);

    expect(screen.getByTestId('api-provider').getAttribute('data-api-key')).toBe('maps-key');
  });

  it('実地図では作り物の地図を重ねない', () => {
    const { container } = render(<ArukuMap apiKey="maps-key" />);

    expect(container.querySelector('svg')).toBeNull();
  });

  it('Wakaba のスタイルを渡す', () => {
    render(<ArukuMap apiKey="maps-key" />);

    expect(mapProps.mock.calls[0][0].styles).toBeInstanceOf(Array);
  });

  it('地図自前のコントロールを出さない', () => {
    render(<ArukuMap apiKey="maps-key" />);

    expect(mapProps.mock.calls[0][0].disableDefaultUI).toBe(true);
  });
});

describe('Maps API が使えるまでの繋ぎ', () => {
  it('読み込み中は作り物の地図を出す', () => {
    currentStatus = 'LOADING';

    const { container } = render(<ArukuMap apiKey="maps-key" />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('google-map')).toBeNull();
  });

  it('まだ読み始めていなくても作り物の地図を出す', () => {
    currentStatus = 'NOT_LOADED';

    const { container } = render(<ArukuMap apiKey="maps-key" />);

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('読み込みに失敗したら作り物の地図のまま', () => {
    currentStatus = 'FAILED';

    const { container } = render(<ArukuMap apiKey="maps-key" />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('google-map')).toBeNull();
  });

  it('認証に失敗したら作り物の地図のまま', () => {
    currentStatus = 'AUTH_FAILURE';

    const { container } = render(<ArukuMap apiKey="maps-key" />);

    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('読み込めたら実地図へ替える', () => {
    currentStatus = 'LOADED';

    const { container } = render(<ArukuMap apiKey="maps-key" />);

    expect(screen.getByTestId('google-map')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('繋ぎの作り物の地図にも showRoute を通す', () => {
    currentStatus = 'LOADING';

    const { container } = render(<ArukuMap apiKey="maps-key" showRoute={false} />);

    expect(container.querySelector('[data-part="route"]')).toBeNull();
  });
});

describe('useFitBounds', () => {
  function fakeMap() {
    return { fitBounds: vi.fn() } as unknown as google.maps.Map & {
      fitBounds: ReturnType<typeof vi.fn>;
    };
  }

  const bounds = { south: 35.6, west: 139.7, north: 35.65, east: 139.75 };

  it('最初の表示で経路全体へ合わせる', () => {
    const map = fakeMap();

    renderHook(() => useFitBounds(map, bounds));

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('矩形が変われば合わせ直す', () => {
    const map = fakeMap();
    const { rerender } = renderHook(({ b }) => useFitBounds(map, b), {
      initialProps: { b: bounds },
    });

    rerender({ b: { ...bounds, north: 35.7 } });

    expect(map.fitBounds).toHaveBeenCalledTimes(2);
  });

  it('中身が同じ矩形なら合わせ直さない', () => {
    const map = fakeMap();
    const { rerender } = renderHook(({ b }) => useFitBounds(map, b), {
      initialProps: { b: bounds },
    });

    rerender({ b: { ...bounds } });

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('矩形が無ければ何もしない', () => {
    const map = fakeMap();

    renderHook(() => useFitBounds(map, null));

    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it('地図が後から来たらその時点で合わせる', () => {
    const map = fakeMap();
    const { rerender } = renderHook(({ m }) => useFitBounds(m, bounds), {
      initialProps: { m: null as google.maps.Map | null },
    });

    rerender({ m: map });

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });
});

describe('経路の描き直し', () => {
  function stubGoogleMaps() {
    const polylines: { options: google.maps.PolylineOptions; setMap: ReturnType<typeof vi.fn> }[] =
      [];
    const markers: { setMap: ReturnType<typeof vi.fn> }[] = [];

    const Polyline = vi.fn(function (options: google.maps.PolylineOptions) {
      const self = { options, setMap: vi.fn() };
      polylines.push(self);
      return self;
    });
    const Marker = vi.fn(function () {
      const self = { setMap: vi.fn() };
      markers.push(self);
      return self;
    });

    vi.stubGlobal('google', {
      maps: { Polyline, Marker, SymbolPath: { CIRCLE: 0 } },
    });
    currentMarkerLibrary = { Marker };
    return { polylines, markers, Marker };
  }

  function fakeMap() {
    return { fitBounds: vi.fn() } as unknown as google.maps.Map;
  }

  beforeEach(() => {
    currentMap = fakeMap();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('経路の区間ごとに線を描く', () => {
    const { polylines } = stubGoogleMaps();

    render(<ArukuMap apiKey="maps-key" route={route()} />);

    expect(polylines).toHaveLength(1);
  });

  it('区間の構成が同じでも座標が変われば描き直す', () => {
    const { polylines } = stubGoogleMaps();
    const { rerender } = render(<ArukuMap apiKey="maps-key" route={route()} />);

    rerender(
      <ArukuMap
        apiKey="maps-key"
        route={route([new GeoPoint(35.7, 139.8), new GeoPoint(35.75, 139.85)])}
      />,
    );

    expect(polylines).toHaveLength(2);
    expect(polylines[0].setMap).toHaveBeenCalledWith(null);
  });

  it('同じ経路のまま描き直されても線は増やさない', () => {
    const { polylines } = stubGoogleMaps();
    const plan = route();
    const { rerender } = render(<ArukuMap apiKey="maps-key" route={plan} />);

    rerender(<ArukuMap apiKey="maps-key" route={plan} />);

    expect(polylines).toHaveLength(1);
  });

  it('画面を閉じたら線を消す', () => {
    const { polylines } = stubGoogleMaps();
    const { unmount } = render(<ArukuMap apiKey="maps-key" route={route()} />);

    unmount();

    expect(polylines[0].setMap).toHaveBeenCalledWith(null);
  });

  it('画面を閉じたら始終点の印も消す', () => {
    const { markers } = stubGoogleMaps();
    const { unmount } = render(<ArukuMap apiKey="maps-key" route={route()} />);

    unmount();

    expect(markers[0].setMap).toHaveBeenCalledWith(null);
  });
});

describe('marker ライブラリの取り込み待ち', () => {
  function stubPolylineOnly() {
    const markers: { setMap: ReturnType<typeof vi.fn> }[] = [];
    const Marker = vi.fn(function () {
      const self = { setMap: vi.fn() };
      markers.push(self);
      return self;
    });
    vi.stubGlobal('google', {
      maps: {
        Polyline: vi.fn(function () {
          return { setMap: vi.fn() };
        }),
        SymbolPath: { CIRCLE: 0 },
      },
    });
    return { markers, Marker };
  }

  function fakeMap() {
    return { fitBounds: vi.fn() } as unknown as google.maps.Map;
  }

  beforeEach(() => {
    currentMap = fakeMap();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marker ライブラリが来るまで印を作らない', () => {
    const { markers } = stubPolylineOnly();
    currentMarkerLibrary = null;

    render(<ArukuMap apiKey="maps-key" route={route()} />);

    expect(markers).toHaveLength(0);
  });

  it('marker ライブラリが来たら印を作る', () => {
    const { markers, Marker } = stubPolylineOnly();
    currentMarkerLibrary = { Marker };

    render(<ArukuMap apiKey="maps-key" route={route()} />);

    expect(markers).toHaveLength(2);
  });

  it('取り込んだライブラリの Marker を使う', () => {
    const { Marker } = stubPolylineOnly();
    currentMarkerLibrary = { Marker };

    render(<ArukuMap apiKey="maps-key" route={route()} />);

    expect(Marker).toHaveBeenCalledTimes(2);
  });

  it('後から来た marker ライブラリでも印を作る', () => {
    const { markers, Marker } = stubPolylineOnly();
    currentMarkerLibrary = null;
    const { rerender } = render(<ArukuMap apiKey="maps-key" route={route()} />);

    currentMarkerLibrary = { Marker };
    rerender(<ArukuMap apiKey="maps-key" route={route()} />);

    expect(markers).toHaveLength(2);
  });
});
