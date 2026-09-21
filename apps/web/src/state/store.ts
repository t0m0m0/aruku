import { createStore, type StoreApi } from 'zustand/vanilla';

import type { GeoPoint } from '@aruku/engine/models/geo-point';
import {
  PickerMode,
  TimeValue,
  calendarDaysBetween,
} from '@aruku/engine/models/time-value';
import { CancellationToken } from '@aruku/engine/services/cancellation';
import {
  RoutePhase,
  type RouteService,
} from '@aruku/engine/services/route-service';
import {
  absoluteMinutes,
  budgetMinutes,
} from '@aruku/engine/services/route-plan-builder';

import { ja } from '../i18n/ja';
import {
  isNowRouteExpired,
  kInitialBudgetMinutes,
  kMinBudgetMinutes,
  routeFreshness,
} from './app-state';
import { classifyRouteError } from './route-error';
import { Screen, screenPath } from '../navigation/screens';
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

  /// 目的地を設定する。名前と座標は必ず対で入れ替える。
  ///
  /// 座標を省いた呼び出しは前の座標を**消す**（移植元の sentinel なし copyWith と
  /// 同じ）。残すと、表示は新しい目的地なのに検索は前の座標へ行く。
  setDestination(name: string | null, latLng?: GeoPoint | null): void;

  /// 出発地を設定する。null は「未設定」ではなく**現在地を使う**の意味で、
  /// home の表示名（departureLabelText）がそれを取得状況へ読み替える。
  setOrigin(name: string | null, latLng?: GeoPoint | null): void;

  /// 画面と、その表示前提データを書き換える唯一の入口。
  ///
  /// 状態を先に確定してから遷移する。逆順にすると、遷移先のガードがまだ古い状態を
  /// 読み、表示前提データが揃っているのに home へ跳ね返される（#386 の不変条件）。
  go(screen: Screen, update?: Partial<RouteCore>): void;

  /// ピッカーが確定した時刻を出発／到着へ反映する。
  ///
  /// どちらを動かしても「出発 < 到着」を保つ: 出発を変えたときは到着を予算幅ごと
  /// 後ろへ押し出し、到着を変えたときは出発 + [kMinBudgetMinutes] へ寄せる。
  /// 押し出した到着は [kMaxDateOffsetDays] の外に立ち得る——選べる範囲を越えたから
  /// といって丸めると、丸めた先が出発より前になる。
  applyPickedTime(picked: {
    mode: PickerMode;
    h: number;
    m: number;
    dateOffset: number;
  }): void;

  /// 基準日が [days] 日進んだぶん、出発・到着を詰め直す。
  ///
  /// [TimeValue.dateOffset] は state に基準日を持たず常に「今日」から数えられる。
  /// 日付を選んでいる最中に日が変われば、保持している値は黙って1日先を指す。
  ///
  /// [days] が 0 でも素通しにしない。跨いでいなくても、今日の過ぎた時刻と「今すぐ」の
  /// 古びは引き上げが要る。[now] を受け取るのは、呼び出し側が [days] を数えた時計と
  /// 揃えるため——ここで読み直すと、その隙に日が変われば基準が食い違う。
  rebaseDates(days: number, now: Date): void;

  /// 保持している出発・到着が数えている基準日を、実時刻の「今日」へ揃える。
  ///
  /// 跨いでいなければ何もしない。跨いでいたら [rebaseDates] と同じ詰め直しが走る。
  rebaseToToday(at: Date): void;

  /// 経路を検索する。home の CTA と、エラー画面の再試行から呼ぶ。
  ///
  /// 画面は home→loading→result / error と進む。移植元は screen と表示前提データを
  /// 同一 copyWith で書いていたが、こちらは 3 つの遷移すべてを [go] 経由にすることで
  /// 同じ不変条件を保つ。
  startSearch(): Promise<void>;

  /// 開いたままの「今すぐ」経路が猶予を超えていれば捨てて home へ戻す（#264）。
  ///
  /// 移植元 `onAppResumed` に相当する。ガードは画面へ**入る**ときしか走らず、
  /// 検索の完了時の砦も照会中の経過しか見ない——結果を開いたまま放置した経路は
  /// どちらにも掛からない。
  revalidateRoute(): void;

  /// 進行中の検索を捨てて home へ戻す（#221）。
  cancelSearch(): void;

  /// 進行中の検索を捨てる。**遷移はしない。**
  ///
  /// 待ち画面から離れたときに呼ぶ。移植元は PopScope で戻るを塞いでいたが、web では
  /// 戻ってサイトを離れるのが当然の挙動なので塞がない——代わりに離脱で止める。
  /// 遷移は既にブラウザが済ませているので、ここから動かすと二重になる。
  ///
  /// 待ち画面の表示前提（routePhase）も落とす——残すとガードが通し、戻る→進むで
  /// 誰も完了させない待ち画面へ入れてしまう。
  ///
  /// 走っていなければ実質何もしない（世代を進めるだけ）。「どの検索を止めてよいか」の
  /// 判断はここには無く、呼ぶ側——離脱の**時点**で現在地を読み直す購読——が持つ
  /// （navigation/search-abandon.ts）。新しい検索が待ち画面へ入り直していれば、
  /// そちらの購読が早期に戻るので巻き添えにならない。
  abandonSearch(): void;

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
    dateBasis: at,
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

/// 経路検索が未配線のときの成り行き。呼ばれた時点で落ちる。
///
/// 黙って失敗する実装（例: 常に ZERO_RESULTS）を既定にすると、配線漏れが「ルートが
/// 見つからない」という**もっともらしい結果**として出てしまい、上流の不調と区別が
/// つかない（router.tsx の depsNotWired と同じ判断）。
/// 経路検索が未配線であることを表す番人。同一性で判定するので中身は呼ばれない
/// （呼ばれる前に [AppActions.startSearch] が落とす）。
const routeServiceNotWired: RouteService = {
  plan: () => {
    throw new Error('RouteService が未配線（createAppStore の第4引数）');
  },
};

export function createAppStore(
  initial: Partial<RouteCore> = {},
  now: Now = () => new Date(),
  location: LocationService = browserLocationService(),
  routeService: RouteService = routeServiceNotWired,
): StoreApi<AppStore> {
  let navigate: Navigate | null = null;

  // 検索の世代。startSearch / cancelSearch のたびに繰り上げ、結果の反映前に一致を
  // 確認する。一致しなければその探索は破棄済み——古い応答が home から result へ
  // 引き戻すのを防ぐ（#221）。
  let searchGeneration = 0;

  // 進行中の検索のキャンセル境界（#259）。世代は「古い応答を書かない」を担うが、
  // それだけでは進行中の HTTP が完了まで走り切る。倒すと通信自体を切る。
  let activeCancellation: CancellationToken | null = null;

  /// 進行中の探索を破棄する。世代を進めて結果の反映を止め、通信そのものも切る。
  function discardSearch(): void {
    searchGeneration++;
    activeCancellation?.cancel();
    activeCancellation = null;
  }

  // 取得中の要求。StrictMode が effect を二度走らせるため、素通しすると権限
  // ダイアログが 2 回出る。移植元に相当物が無いのはこの事情が無いから。
  let inFlight: Promise<void> | null = null;

  return createStore<AppStore>()((set, get) => ({
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

    setDestination(name: string | null, latLng: GeoPoint | null = null) {
      set({ destination: name, destinationLatLng: latLng });
    },

    setOrigin(name: string | null, latLng: GeoPoint | null = null) {
      set({ origin: name, originLatLng: latLng });
    },

    applyPickedTime({ mode, h, m, dateOffset }) {
      const picked = new TimeValue({ h, m, dateOffset });
      const state = get();
      // 出発と到着は必ず同じ set で書く。片方ずつ通すと、途中の食い違い
      // （出発だけ動いて到着を追い越した状態）を次の更新が本物の値として読む。
      set(
        mode === PickerMode.depart
          ? {
              ...discardedRoute,
              departure: picked,
              arrival: arrivalAfterDeparture(
                picked,
                state.departure,
                state.arrival,
              ),
            }
          : {
              ...discardedRoute,
              arrival: clampArrivalAfterDeparture(state.departure, picked),
            },
      );
    },

    rebaseDates(days: number, at: Date) {
      const state = get();
      // 予算幅を先に測る。詰めてから測ると、引き上げられた出発と古い到着の差を
      // 「変更前の予算」として引き継いでしまう。
      const budget = budgetMinutes(state.departure, state.arrival);
      const departure = rebasedTime(state.departure, days, at);
      set({
        ...discardedRoute,
        departure,
        arrival: timeValueFromAbs(absoluteMinutes(departure) + budget),
        // 基準日は、それが数えている出発・到着と**同じ更新で**動かす。別々に書くと、
        // 間に挟まる描画が新しい基準で古い offset を読む。
        dateBasis: at,
      });
    },

    /// 保持値が数えている「今日」を実時刻へ合わせる。ズレていなければ何もしない。
    ///
    /// dateOffset を絶対日付へ直すのは、この state ではなく**照会側**（エンジンの
    /// `departureDateTime`）と**欄**で、どちらも自分の時計の「今日」から数える。
    /// 開いたまま日を跨いだ保持値をそのまま渡すと、明日の予定が明後日として照会
    /// され、戻ってきた欄は今日の予定を昨日基準で描く（PR #399 の Codex レビュー）。
    rebaseToToday(at: Date) {
      const drift = calendarDaysBetween({ from: get().dateBasis, to: at });
      if (drift !== 0) get().rebaseDates(drift, at);
    },

    async startSearch() {
      // 配線漏れは検索の失敗ではなく組み立ての誤り。下の try に拾わせると
      // `unknown` へ分類され、「ルートを取得できませんでした」という**もっともらしい
      // 画面**になって上流の不調と区別がつかなくなる（PR #398 の Codex レビュー）。
      if (routeService === routeServiceNotWired) {
        throw new Error('RouteService が未配線（createAppStore の第4引数）');
      }

      const generation = ++searchGeneration;
      // キャンセルを挟まない連打でも、古い通信を放置せず切る（#259）。
      activeCancellation?.cancel();
      const cancellation = (activeCancellation = new CancellationToken());

      // isNow 出発は起動時刻のまま腐るので、照会直前に現在時刻へ更新する（#264）。
      // ただし state への確定は成功時まで遅らせる——失敗して旧経路を残す場合に、
      // ヘッダー（出発）だけ新時刻へ動いて旧経路のタイムラインとズレるため。
      const at = now();
      // 詰め直しは refreshedNowTimes より**先**。あちらは isNow の時刻を今日基準で
      // 組み直すので、基準がずれたままだと新旧の基準が混ざる。
      get().rebaseToToday(at);
      const refreshed = refreshedNowTimes(get(), at);

      get().go(Screen.loading, {
        routeErrorKind: null,
        routePhase: RoutePhase.routing,
      });

      const state = get();
      const origin =
        state.originLatLng ??
        (state.locationState.kind === 'available'
          ? state.locationState.position
          : null);

      try {
        const plan = await routeService.plan({
          destination: state.destination,
          destinationLatLng: state.destinationLatLng,
          departure: refreshed.departure,
          arrival: refreshed.arrival,
          origin,
          originName: departureNameForRoute(state),
          cancellation,
          onProgress: (phase) => {
            if (generation !== searchGeneration) return;
            set({ routePhase: phase });
          },
        });
        if (generation !== searchGeneration) return;

        // 照会中に猶予を超えた（isNow で古びた）場合は、古い前提の結果を出さず
        // home へ戻して再検索を促す。ローディング中は画面遷移で無効化できないので、
        // 完了時のここが最後の砦（#264）。
        if (
          refreshed.departure.isNow &&
          now().getTime() - at.getTime() >= routeFreshness
        ) {
          const closed = now();
          get().rebaseToToday(closed);
          expireRoute(get(), closed);
          return;
        }

        // 成功時に出発・到着・経路・失効基準をまとめて確定する。routeAsOf を持つのは
        // isNow 経路だけ（固定出発は時間経過で腐らない）。
        get().go(Screen.result, {
          route: plan,
          routeAsOf: refreshed.departure.isNow ? at : null,
          departure: refreshed.departure,
          arrival: refreshed.arrival,
          // 出発・到着を書くなら基準日も同じ更新で書く（[RouteCore.dateBasis]）。
          dateBasis: at,
          routeErrorKind: null,
          routePhase: null,
        });
      } catch (error) {
        if (generation !== searchGeneration) return;
        // 出発・到着も旧経路も routeAsOf も触らない。出発を確定していないので、
        // 旧経路を残してもヘッダーとタイムラインの前提時刻は一致したまま。
        get().go(Screen.error, {
          routeErrorKind: classifyRouteError(error),
          routePhase: null,
        });
      }
    },

    revalidateRoute() {
      const state = get();
      const at = now();
      if (!isNowRouteExpired(state, at)) return;
      get().rebaseToToday(at);
      expireRoute(get(), at);
    },

    cancelSearch() {
      discardSearch();
      get().go(Screen.home, { routePhase: null, routeErrorKind: null });
    },

    abandonSearch() {
      discardSearch();
      // 表示前提も落とす。残すと、戻る→進むで待ち画面の loader が「前提は揃って
      // いる」と読んで通してしまい、誰も完了させない待ち画面に入れる
      // （PR #398 の Codex レビュー）。
      //
      // **遷移はしない。** 戻る操作の後始末（watchSearchAbandon）では既にブラウザが
      // 済ませており、デスクトップのシェルのタブでは呼び手が続けて1回だけ遷移する
      // ——ここで home へ動くと、その2本が競合する（PR #407 の Codex レビュー）。
      set({ routePhase: null });
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

/// 失効した経路を捨てて home へ戻す（#264）。出発・到着は現在時刻基準へ寄せ直す。
///
/// 呼ぶ側が先に [AppActions.rebaseToToday] を通しておくこと。ここが組む isNow の時刻は
/// 今日基準なので、基準がずれたままだと固定側の offset と混ざる。詰め直しをここへ
/// 入れないのは、それが state を書き換えて、受け取った [state] を古くするため——
/// 書き換える側と読む側を1つの関数に同居させない。
function expireRoute(state: AppStore, at: Date): void {
  const refreshed = refreshedNowTimes(state, at);
  state.go(Screen.home, {
    route: null,
    routeAsOf: null,
    routePhase: null,
    routeErrorKind: null,
    departure: refreshed.departure,
    arrival: refreshed.arrival,
    dateBasis: at,
  });
}

/// 照会に使う出発・到着。isNow なら現在時刻へ更新し、予算幅を保って到着も追従させる。
///
/// 移植元 `_refreshedNowTimes`。呼び出し側が [now] を渡すのは、遷移や失効判定と
/// 同じ時計で数えるため——ここで読み直すと、その隙に分が変われば基準がずれる。
function refreshedNowTimes(
  state: RouteCore,
  at: Date,
): { departure: TimeValue; arrival: TimeValue } {
  const { departure, arrival } = state;
  if (!departure.isNow) return { departure, arrival };

  const budget = budgetMinutes(departure, arrival);
  const next = new TimeValue({ h: at.getHours(), m: at.getMinutes(), isNow: true });
  return { departure: next, arrival: timeValueFromAbs(absoluteMinutes(next) + budget) };
}

/// 移植元 `_timeValueFromAbs`。日跨ぎぶんを dateOffset へ繰り上げる。
function timeValueFromAbs(abs: number): TimeValue {
  return new TimeValue({
    h: Math.floor(abs / 60) % 24,
    m: abs % 60,
    dateOffset: Math.floor(abs / (24 * 60)),
  });
}

/// 時刻が動いたら保持中の経路は捨てる。
///
/// 移植元には無い。あちらに「進む」が無かったからで、web では result から戻っても
/// その履歴エントリが前方に残る。ガードは `route` が在れば通すので、捨てないと
/// 新しい出発のヘッダーの下に古い時刻で組んだ経路が出る（PR #399 の Codex レビュー）。
const discardedRoute = { route: null, routeAsOf: null } as const;

/// 出発を変更したときの到着。移植元 `_arrivalAfterDeparture`。
///
/// 予算が [kMinBudgetMinutes] を割るときだけ、変更前の予算を保ったまま後ろへずらす。
/// 前へ動かして予算が広がる場合は据え置く——広がったぶんを詰めると、出発を戻すだけの
/// 操作が到着まで巻き込む。
function arrivalAfterDeparture(
  newDeparture: TimeValue,
  oldDeparture: TimeValue,
  arrival: TimeValue,
): TimeValue {
  const newDepAbs = absoluteMinutes(newDeparture);
  if (absoluteMinutes(arrival) - newDepAbs >= kMinBudgetMinutes) return arrival;

  const oldBudget = absoluteMinutes(arrival) - absoluteMinutes(oldDeparture);
  const keep = oldBudget >= kMinBudgetMinutes ? oldBudget : kMinBudgetMinutes;
  return timeValueFromAbs(newDepAbs + keep);
}

/// 到着を変更したときの到着。移植元 `_clampArrivalAfterDeparture`。
function clampArrivalAfterDeparture(
  departure: TimeValue,
  arrival: TimeValue,
): TimeValue {
  const minAbs = absoluteMinutes(departure) + kMinBudgetMinutes;
  return absoluteMinutes(arrival) >= minAbs ? arrival : timeValueFromAbs(minAbs);
}

/// 基準日が [days] 進んだときの時刻。移植元 `_rebased`。
function rebasedTime(t: TimeValue, days: number, now: Date): TimeValue {
  // 「今すぐ」も h/m は applyPickedTime の比較に使われる。据え置くと、直後に確定した
  // 到着が古い出発の1分後へ潰れる。
  if (t.isNow) return t.copyWith({ h: now.getHours(), m: now.getMinutes() });

  const atNow = () => new TimeValue({ h: now.getHours(), m: now.getMinutes() });
  // 指していた日が過ぎ去ったなら、詰めた先は負になる。過去は選べないので現在時刻へ。
  if (t.dateOffset < days) return atNow();

  const shifted = t.dateOffset - days;
  if (shifted === 0 && t.totalMinutes < now.getHours() * 60 + now.getMinutes()) {
    return atNow();
  }
  return t.copyWith({ dateOffset: shifted });
}

/// 経路照会へ渡す出発地の名前。移植元 `departureNameForRoute`。
///
/// 手動指定が無いときは現在地を使うが、その名前を付けられるのは実際に測位できて
/// いるときだけ。取得中・拒否・失敗で「現在地」と名乗らせると、座標の無い出発地が
/// 名前だけ持って照会へ行く。
function departureNameForRoute(state: AppStore): string | null {
  if (state.origin !== null) return state.origin;
  return state.locationState.kind === 'available'
    ? ja.searchCurrentLocationName
    : null;
}
