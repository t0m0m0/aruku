// 移植元: lib/core/services/location_service.dart。

import { describe, expect, it, vi } from 'vitest';

import { browserLocationService } from '../../src/location/geolocation';

/// W3C の GeolocationPositionError の数値。定数はブラウザ側にしか無いので置き直す。
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

function geolocation(
  behaviour: (
    onSuccess: PositionCallback,
    onError: PositionErrorCallback,
  ) => void,
): Geolocation {
  return {
    getCurrentPosition: (onSuccess, onError) =>
      behaviour(onSuccess, onError ?? (() => {})),
    watchPosition: () => 0,
    clearWatch: () => {},
  };
}

function succeedsAt(latitude: number, longitude: number): Geolocation {
  return geolocation((onSuccess) =>
    onSuccess({
      coords: { latitude, longitude } as GeolocationCoordinates,
      timestamp: 0,
      toJSON: () => ({}),
    } as GeolocationPosition),
  );
}

function failsWith(code: number): Geolocation {
  return geolocation((_onSuccess, onError) =>
    onError({ code, message: '' } as GeolocationPositionError),
  );
}

describe('browserLocationService', () => {
  it('取得できたら座標を available として返す', async () => {
    const state = await browserLocationService(succeedsAt(35.681, 139.767)).request();

    expect(state.kind).toBe('available');
    expect(state.kind === 'available' && state.position.lat).toBe(35.681);
    expect(state.kind === 'available' && state.position.lng).toBe(139.767);
  });

  it('権限を拒否されたら denied を返す', async () => {
    const state = await browserLocationService(failsWith(PERMISSION_DENIED)).request();

    expect(state.kind).toBe('denied');
  });

  // 再試行で解消し得る失敗は denied に丸めない。ホームは denied を「位置情報なし」、
  // unavailable を「取得失敗」と出し分け、後者だけ再取得を促す。
  it('測位できなかったら再試行可能な unavailable を返す', async () => {
    const state = await browserLocationService(failsWith(POSITION_UNAVAILABLE)).request();

    expect(state.kind).toBe('unavailable');
  });

  it('打ち切られたら再試行可能な unavailable を返す', async () => {
    const state = await browserLocationService(failsWith(TIMEOUT)).request();

    expect(state.kind).toBe('unavailable');
  });

  it('未知のエラーコードは再試行可能な unavailable へ寄せる', async () => {
    const state = await browserLocationService(failsWith(99)).request();

    expect(state.kind).toBe('unavailable');
  });

  // 測位中に例外が飛ぶ経路。理由が分からない以上、拒否とは断定できない。
  it('呼び出し自体が例外を投げたら unavailable を返す', async () => {
    const throwing = {
      getCurrentPosition: () => {
        throw new Error('boom');
      },
      watchPosition: () => 0,
      clearWatch: () => {},
    } satisfies Geolocation;

    const state = await browserLocationService(throwing).request();

    expect(state.kind).toBe('unavailable');
  });

  // 非セキュアコンテキストなど、この環境では geolocation そのものが生えない。
  // 再取得しても解消しないので、再試行を促す unavailable ではなく denied。
  it('Geolocation API が無い環境では denied を返す', async () => {
    const state = await browserLocationService(undefined).request();

    expect(state.kind).toBe('denied');
  });

  // 移植元は LocationSettings() の既定 LocationAccuracy.best で呼んでおり、
  // geolocator_web はそれを enableHighAccuracy: true へ写す。W3C の既定は false
  // なので、渡さないと粗い推定を掴み、経路の出発地が別の通りから始まる。
  it('高精度を要求する（移植元の既定と揃える）', async () => {
    const getCurrentPosition = vi.fn<Geolocation['getCurrentPosition']>();
    const spy = {
      getCurrentPosition,
      watchPosition: () => 0,
      clearWatch: () => {},
    } satisfies Geolocation;

    void browserLocationService(spy).request();

    expect(getCurrentPosition.mock.calls[0]?.[2]?.enableHighAccuracy).toBe(true);
  });

  it('W3C の timeout はミリ秒で渡す', async () => {
    const getCurrentPosition = vi.fn<Geolocation['getCurrentPosition']>();
    const spy = {
      getCurrentPosition,
      watchPosition: () => 0,
      clearWatch: () => {},
    } satisfies Geolocation;

    void browserLocationService(spy, 10_000).request();

    expect(getCurrentPosition.mock.calls[0]?.[2]?.timeout).toBe(10_000);
  });
});
