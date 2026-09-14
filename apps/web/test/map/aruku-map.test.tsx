// 移植元: lib/shared/widgets/aruku_map.dart。
//
// 実地図そのものは jsdom に存在しない（Maps JS API は読み込まれない）。ここが押さえるのは
// ライブラリへ渡す手前の分岐——どちらの地図を出すか、経路が差し替わったときカメラを
// 合わせ直すか——で、それを越えた先は Maps API の責任。

import { render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import {
  RoutePlan,
  RouteSegment,
  SegmentType,
} from '@aruku/engine/models/route-plan';

const mapProps = vi.fn();

/// useMap はライブラリが地図を用意し終えるまで null を返す。テストごとに「まだ来ていない」
/// と「もう在る」を切り替えられるよう、モジュール変数越しに返す。
let currentMap: google.maps.Map | null = null;

/// Maps JS API の読み込み状態。既定は読み込み済み。
let currentStatus = 'LOADED';

vi.mock('@vis.gl/react-google-maps', () => ({
  APILoadingStatus: {
    NOT_LOADED: 'NOT_LOADED',
    LOADING: 'LOADING',
    LOADED: 'LOADED',
    FAILED: 'FAILED',
    AUTH_FAILURE: 'AUTH_FAILURE',
  },
  useApiLoadingStatus: () => currentStatus,
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
});

describe('ArukuMap', () => {
  it('キーが無ければ作り物の地図を描く', () => {
    const { container } = render(<ArukuMap apiKey="" />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('google-map')).toBeNull();
  });

  // キーが無いのは「設定漏れ」であって、経路が無いのとは別。落ちずに作り物へ倒れる。
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

    expect(screen.getByTestId('api-provider').getAttribute('data-api-key')).toBe(
      'maps-key',
    );
  });

  it('実地図では作り物の地図を重ねない', () => {
    const { container } = render(<ArukuMap apiKey="maps-key" />);

    expect(container.querySelector('svg')).toBeNull();
  });

  it('Wakaba のスタイルを渡す', () => {
    render(<ArukuMap apiKey="maps-key" />);

    expect(mapProps.mock.calls[0]![0].styles).toBeInstanceOf(Array);
  });

  // 移植元は zoomControls/mapToolbar/myLocationButton を個別に落としている。
  it('地図自前のコントロールを出さない', () => {
    render(<ArukuMap apiKey="maps-key" />);

    expect(mapProps.mock.calls[0]![0].disableDefaultUI).toBe(true);
  });
});

// 移植元は supportsRealMap(isWeb, flagEnabled, mapsJsLoaded) で、Maps JS API の読み込みが
// 済むまで作り物の地図を描き続ける。APIProvider はスクリプトを読みに行くだけで、読めるまでの
// 間や読めなかったときに代わりの絵を出してはくれない——素通しにすると、result の 180px の
// プレビューと loading の背景がその間まるごと空白になる。
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

  // オフライン・CSP での遮断。
  it('読み込みに失敗したら作り物の地図のまま', () => {
    currentStatus = 'FAILED';

    const { container } = render(<ArukuMap apiKey="maps-key" />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('google-map')).toBeNull();
  });

  // ライブラリ 1.10.0 はこの状態へ遷移しない（LOADING / LOADED / FAILED の3つだけ）。
  // 将来出るようになったときに素通ししないための一本で、いま何かを守ってはいない。
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

  // 繋ぎの間も loading の背景は経路を描かない。
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

  // 代替案の切り替えで route オブジェクトは毎回作り直されるが、同じ経路なら矩形は同じ。
  // 値ではなく参照で見ると、ここでカメラが飛ぶ。
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

  // 地図はライブラリが用意し終わるまで null で来る。準備前の呼び出しを捨てるだけだと
  // 初回のフィットごと失われるので、揃った時点で合わせる。
  it('地図が後から来たらその時点で合わせる', () => {
    const map = fakeMap();
    const { rerender } = renderHook(({ m }) => useFitBounds(m, bounds), {
      initialProps: { m: null as google.maps.Map | null },
    });

    rerender({ m: map });

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });
});


// 経路の図形を実際に地図へ載せる層。google.maps は jsdom に無いので、コンストラクタだけ
// 差し替えて「何本、どの点で描いたか」と「消したか」を見る。
describe('経路の描き直し', () => {
  function stubGoogleMaps() {
    const polylines: { options: google.maps.PolylineOptions; setMap: ReturnType<typeof vi.fn> }[] = [];
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
    return { polylines, markers };
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

  // 代替案の切り替えでは区間の構成が同じまま座標だけ変わることがある。区間 id だけを
  // 見て描き直しを決めると、古い経路の線が地図に残り続ける。
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
    expect(polylines[0]!.setMap).toHaveBeenCalledWith(null);
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

    expect(polylines[0]!.setMap).toHaveBeenCalledWith(null);
  });

  it('画面を閉じたら始終点の印も消す', () => {
    const { markers } = stubGoogleMaps();
    const { unmount } = render(<ArukuMap apiKey="maps-key" route={route()} />);

    unmount();

    expect(markers[0]!.setMap).toHaveBeenCalledWith(null);
  });
});
