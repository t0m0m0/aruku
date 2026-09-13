import { createStore, type StoreApi } from 'zustand/vanilla';

import { TimeValue } from '@aruku/engine/models/time-value';

import { kInitialBudgetMinutes } from './app-state';
import { screenPath, type Screen } from '../navigation/screens';
import {
  browserLocationService,
  type LocationService,
} from '../location/geolocation';
import {
  locationLoading,
  locationUnavailable,
  type LocationState,
} from '../location/location-state';
import type { RouteCore } from './app-state';

export type Navigate = (path: string) => void;

export interface AppActions {
  /// 現在地を取り直す。ホームのコンパスボタンと、起動直後の初回取得から呼ぶ。
  refreshLocation(): Promise<void>;

  /// 画面と、その表示前提データを書き換える唯一の入口。
  ///
  /// 状態を先に確定してから遷移する。逆順にすると、遷移先のガードがまだ古い状態を
  /// 読み、表示前提データが揃っているのに home へ跳ね返される（#386 の不変条件）。
  go(screen: Screen, update?: Partial<RouteCore>): void;

  /// ルーターを繋ぐ。
  ///
  /// コンストラクタ引数にしないのは循環のため——ルーターはガードのためにストアを
  /// 読み、ストアは遷移のためにルーターを呼ぶ。どちらかを後から差す必要がある。
  attachNavigator(navigate: Navigate): void;
}

/// 経路の表示前提（[RouteCore]）に含めない状態。
///
/// 現在地はガードの判定材料ではない——取得できていなくても home も検索も開ける。
/// [RouteCore] に混ぜると、go() の update で書けてしまい「画面と一緒に書き換える
/// もの」という [RouteCore] の意味が薄れる。
export interface AppAmbient {
  locationState: LocationState;
}

export type AppStore = RouteCore & AppAmbient & AppActions;

/// 現在時刻の供給元。テストで初期値を固定できるよう注入可能にする。
export type Now = () => Date;

/// 移植元の `AppState.initial` + `AppNotifier.build()` の初期値。
///
/// 00:00 のリテラルをそのまま運んではいけない。移植元はそれを build() で現在時刻と
/// 「出発 + [kInitialBudgetMinutes]」へ差し替えており、リテラルのままだと予算 0 分の
/// 検索になり、isNow の出発も深夜 0 時に固定される（PR #391 レビュー）。
function initialCore(now: Now): RouteCore {
  const at = now();
  // 日跨ぎ（深夜出発）は arrival の dateOffset に繰り上げる。
  const arrivalTotal = at.getHours() * 60 + at.getMinutes() + kInitialBudgetMinutes;
  return {
    destination: null,
    destinationLatLng: null,
    origin: null,
    originLatLng: null,
    departure: new TimeValue({
      h: at.getHours(),
      m: at.getMinutes(),
      isNow: true,
    }),
    arrival: new TimeValue({
      h: Math.floor(arrivalTotal / 60) % 24,
      m: arrivalTotal % 60,
      dateOffset: Math.floor(arrivalTotal / (24 * 60)),
    }),
    route: null,
    routeAsOf: null,
    routeErrorKind: null,
    routePhase: null,
  };
}

export function createAppStore(
  initial: Partial<RouteCore> = {},
  now: Now = () => new Date(),
  location: LocationService = browserLocationService(),
): StoreApi<AppStore> {
  let navigate: Navigate | null = null;

  // 取得中の要求。StrictMode が effect を二度走らせるため、素通しすると権限
  // ダイアログが 2 回出る。移植元に相当物が無いのはこの事情が無いから。
  let inFlight: Promise<void> | null = null;

  return createStore<AppStore>()((set) => ({
    ...initialCore(now),
    locationState: locationLoading,
    ...initial,

    refreshLocation() {
      if (inFlight !== null) return inFlight;

      inFlight = location
        .request()
        // 失敗理由は LocationState として返る設計だが、想定外の例外は権限拒否と
        // 断定できないため再試行可能な側へ寄せる。
        .catch(() => locationUnavailable)
        .then((result) => {
          set({ locationState: result });
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    attachNavigator(next: Navigate) {
      navigate = next;
    },

    go(screen: Screen, update: Partial<RouteCore> = {}) {
      // 未接続で静かに状態だけ進めない。画面と前提データが乖離したまま次の遷移を
      // 迎えると、ガードは「前提を欠く deep link」と区別できない。
      if (navigate === null) {
        throw new Error('go() before attachNavigator()');
      }
      set(update);
      navigate(screenPath[screen]);
    },
  }));
}
