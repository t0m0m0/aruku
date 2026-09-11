import { createStore, type StoreApi } from 'zustand/vanilla';

import { TimeValue } from '@aruku/engine/models/time-value';

import { screenPath, type Screen } from '../navigation/screens';
import type { RouteCore } from './app-state';

export type Navigate = (path: string) => void;

export interface AppActions {
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

export type AppStore = RouteCore & AppActions;

/// 移植元 `AppState.initial` と同じ初期値。
function initialCore(): RouteCore {
  return {
    destination: null,
    destinationLatLng: null,
    origin: null,
    originLatLng: null,
    departure: new TimeValue({ h: 0, m: 0, isNow: true }),
    arrival: new TimeValue({ h: 0, m: 0 }),
    route: null,
    routeAsOf: null,
    routeErrorKind: null,
    routePhase: null,
  };
}

export function createAppStore(
  initial: Partial<RouteCore> = {},
): StoreApi<AppStore> {
  let navigate: Navigate | null = null;

  return createStore<AppStore>()((set) => ({
    ...initialCore(),
    ...initial,

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
