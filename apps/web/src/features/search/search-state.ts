// 移植元: lib/features/search/places_provider.dart
//
// 画面ごとに作って捨てる。移植元は provider（アプリ寿命）に置いていたが、検索の
// 入力・候補・モードはこの画面の外に意味が無く、残しておくと次に開いたとき前回の
// 候補が一瞬見える。

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { GeoPoint } from '@aruku/engine/models/geo-point';

import type { PlacePrediction } from '../../places/place-prediction';
import { PlacesException, type PlacesService } from '../../places/places-service';

/// 手が止まったと見なすまでの待ち（ミリ秒）。1文字ごとに投げると課金リクエストが
/// 打鍵数だけ出る。
export const searchDebounce = 400;

export type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface SearchStateValue {
  readonly status: SearchStatus;
  readonly suggestions: PlacePrediction[];

  /// PlacesException の生ステータス（例: 'REQUEST_DENIED'）。null は原因不明の
  /// 汎用エラー。文言への変換は画面が持つ（#170）。
  readonly errorStatus: string | null;

  /// 「近くの店」モード（#146）。ON のとき候補を現在地からの距離の昇順へ
  /// 並べ替える（取得の系統は typeahead のまま・C案）。
  readonly nearby: boolean;
}

export interface SearchActions {
  search(query: string): void;
  setNearby(value: boolean): void;

  /// 待っている debounce を捨てる。画面のアンマウントで呼ぶ。
  dispose(): void;
}

export type SearchState = StoreApi<SearchStateValue & SearchActions>;

export interface SearchStateOptions {
  readonly service: PlacesService;

  /// 位置バイアスと距離並べ替えの基準。位置情報が確定しているときだけ座標を返す。
  readonly currentLocation: () => GeoPoint | null;
}

export function createSearchState(options: SearchStateOptions): SearchState {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  // 検索ごとに増やすリクエスト世代。新しい検索が始まった後に古い結果で
  // 表示を上書きしないよう、反映前に世代一致を確かめる。
  let generation = 0;

  // 直近の取得結果（関連度順・未ソート）。距離は通常検索でも各候補に付くため、
  // モード切替はこれを並べ替えるだけで済み、再フェッチ（課金・遅延）を避けられる。
  let raw: PlacePrediction[] = [];

  return createStore<SearchStateValue & SearchActions>()((set, get) => {
    async function fetch(query: string, gen: number): Promise<void> {
      const location = options.currentLocation();
      try {
        // 系統は常に Autocomplete（typeahead を壊さない・#146 C案）。現在地が
        // 分かるときは位置バイアスを掛け（#144）、proxy 側で origin も渡るため
        // 各候補に距離が付く。
        const fetched = await options.service.autocomplete(query, location);
        if (gen !== generation) return;
        raw = fetched;
        set({
          status: 'success',
          suggestions: arrange(get().nearby, location, fetched),
          errorStatus: null,
        });
      } catch (error) {
        if (gen !== generation) return;
        set({
          status: 'error',
          suggestions: [],
          errorStatus:
            error instanceof PlacesException ? error.status : null,
        });
      }
    }

    return {
      status: 'idle',
      suggestions: [],
      errorStatus: null,
      nearby: false,

      search(query: string) {
        if (debounce !== null) clearTimeout(debounce);
        // 空のクエリでも世代を進める。進めないと、走っている取得が後から
        // 「候補あり」を書き戻し、消したはずの入力に候補が残る。
        generation++;

        if (query === '') {
          raw = [];
          // クエリは消してもモード（nearby）は保つ。
          set({ status: 'idle', suggestions: [], errorStatus: null });
          return;
        }

        set({ status: 'loading', suggestions: [], errorStatus: null });
        const gen = generation;
        debounce = setTimeout(() => {
          void fetch(query, gen);
        }, searchDebounce);
      },

      /// 「近くの店」モードの切替。取得済みの候補をその場で並べ替えるだけで
      /// 問い合わせ直さない（課金リクエストと待ちを省く）。
      ///
      /// まだ結果が無い／取得中はフラグだけ更新し、走っている取得の完了時に
      /// 正しい並びで反映する。
      ///
      /// 距離は取得時に origin を送って初めて候補へ付くため、取得時点で現在地が
      /// 未確定だった候補は後から現在地が届いても並べ替えられない（トグルが無反応に
      /// 見える）。再フェッチで埋めることは可能だが、切替のたびに課金リクエストが
      /// 増えるため採らない。docs/spec/place-search.md §6 に既知の限界として記載。
      setNearby(value: boolean) {
        if (get().nearby === value) return;
        if (get().status !== 'success') {
          set({ nearby: value });
          return;
        }
        set({
          nearby: value,
          suggestions: arrange(value, options.currentLocation(), raw),
        });
      },

      dispose() {
        if (debounce !== null) clearTimeout(debounce);
        debounce = null;
        // 走っている取得を捨てる。解決しても世代が合わず反映されない。
        generation++;
      },
    };
  });
}

/// nearby モードかつ現在地ありなら距離の昇順へ並べ替え、そうでなければ関連度順のまま。
/// 取得時と切替時で同じ並べ替え規則を共有する。
function arrange(
  nearby: boolean,
  location: GeoPoint | null,
  items: PlacePrediction[],
): PlacePrediction[] {
  return nearby && location !== null ? sortByDistance(items) : items;
}

/// 距離の取れた候補を先に距離の昇順、距離不明の候補は元の関連度順のまま末尾へ回す（C案）。
///
/// 距離不明を 0 として混ぜない。基準の取れない候補が先頭を占め、「近くの店」が
/// 近さと無関係な並びになる。
function sortByDistance(items: PlacePrediction[]): PlacePrediction[] {
  const withDistance: PlacePrediction[] = [];
  const without: PlacePrediction[] = [];
  for (const item of items) {
    (item.distanceMeters === null ? without : withDistance).push(item);
  }
  withDistance.sort((a, b) => a.distanceMeters! - b.distanceMeters!);
  return [...withDistance, ...without];
}
