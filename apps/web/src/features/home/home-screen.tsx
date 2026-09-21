// 移植元: lib/features/home/home_screen.dart と home_widgets.dart。
//
// 週間目標カード（_WeeklyGoalCard / _WeeklyProgress / _TodayLine /
// _GoalRingPainter / _ActivityUnsupportedNote、約 280 行）は運んでいない。
// ブラウザに歩数 API が無く、加速度から自作してもタブが背面で止まるため、#386 が
// 「歩数まわりの導線は最初から作らない」と決めている。非対応の理由を出す注記も
// 一緒に消える——出す相手の機能が無い。

import { useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { PickerMode, TimeValue } from '@aruku/engine/models/time-value';
import { budgetMinutes } from '@aruku/engine/services/route-plan-builder';

import { todayGreeting } from '../../i18n/format';
import { useIsDesktop } from '../../layout/use-is-desktop';
import { useInitialLocation } from '../../location/use-initial-location';
import { ja } from '../../i18n/ja';
import type { ScreenDeps } from '../../navigation/screen-deps';
import { Screen } from '../../navigation/screens';
import { ArukuButton } from '../../shared/button';
import { IconHitButton } from '../../shared/icon-hit-button';
import {
  ChevronIcon,
  ClockIcon,
  CompassIcon,
  PinIcon,
  RoutesIcon,
  SearchIcon,
  SettingsIcon,
} from '../../shared/icons';
import { TimeField } from '../picker/time-field';
import { TypeaheadField } from '../search/typeahead-field';
import { departureLabelText } from '../../state/derived';
import type { AppStore } from '../../state/store';
import styles from './home-screen.module.css';

interface HomeScreenProps {
  store: StoreApi<AppStore>;

  /// デスクトップ幅のインライン検索欄が使う。モバイル幅では触らない——目的地は
  /// 全画面の検索画面が決める。
  deps: ScreenDeps;

  /// 経路検索の開始。目的地が決まっているときの CTA から呼ぶ。
  ///
  /// null は「経路検索のライフサイクルがまだ無い」。CTA を押せなくして、そう見える
  /// ラベルにする。黙って何もしない関数を渡さないのは、繋ぎ忘れが「押しても反応
  /// しないボタン」として残るため（router.tsx の同じ判断）。
  onStartSearch: (() => void) | null;

  /// 挨拶に使う現在時刻。テストで時刻帯を固定できるよう注入可能にする。
  now?: () => Date;
}

export function HomeScreen({
  store,
  deps,
  onStartSearch,
  now = () => new Date(),
}: HomeScreenProps) {
  const isDesktop = useIsDesktop();
  const origin = useStore(store, (s) => s.origin);
  const destination = useStore(store, (s) => s.destination);
  const departure = useStore(store, (s) => s.departure);
  const arrival = useStore(store, (s) => s.arrival);
  const locationState = useStore(store, (s) => s.locationState);
  const go = useStore(store, (s) => s.go);
  const refreshLocation = useStore(store, (s) => s.refreshLocation);

  // 子画面から戻るたびに再マウントされるので、まだ一度も取っていないときだけ走る
  // （PR #394 レビュー）。取り直しはコンパスという明示の導線がある。
  useInitialLocation(store);

  const destinationField = useRef<HTMLInputElement>(null);

  /// 目的地を決めに行く。デスクトップ幅ではその場の欄へ焦点を移すだけで、
  /// 全画面の検索へは飛ばさない——この幅のために作った導線を自分で迂回しない
  /// （PR #407 の Codex レビュー）。
  const goSearch = () => {
    if (isDesktop) {
      destinationField.current?.focus();
      return;
    }
    go(Screen.search);
  };

  const departureText = departureLabelText(origin, locationState);
  const destinationText = destination ?? ja.homeDestinationPlaceholder;

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.greeting}>
          <p className={styles.greetingDate}>{todayGreeting(now())}</p>
          <h1 className={styles.greetingLead}>
            {ja.homeGreetingLead}
            <span className={styles.greetingHighlight}>
              {ja.homeGreetingHighlight}
            </span>
          </h1>
        </div>
        <button
          type="button"
          className={`card ${styles.settings}`}
          aria-label={ja.homeOpenSettings}
          onClick={() => {
            go(Screen.settings);
          }}
        >
          <SettingsIcon size={20} />
        </button>
      </header>

      <section className={`card ${styles.places}`}>
        <span className={styles.thread} aria-hidden="true">
          <span className={styles.threadDot} />
          <span className={styles.threadLine} />
          <PinIcon size={16} filled />
        </span>

        {/* 行の本体と末尾のアイコンは別の操作なので、入れ子にはできない（button の
            中に button は置けない）。横に並べる器で包む。 */}
        <div className={styles.placeRow}>
          {/* 読み上げ名は aria-label で明示する。中身から組ませると、要素が横並びか
              縦積みかで語の区切りが変わる——見た目の都合が読み上げに漏れる。 */}
          <button
            type="button"
            className={styles.placeMain}
            aria-label={`${ja.homeDepartureLabel} ${departureText}`}
            onClick={() => {
              go(Screen.searchOrigin);
            }}
          >
            <span className={styles.placeLabel}>{ja.homeDepartureLabel}</span>
            <span className={styles.placeValue}>{departureText}</span>
          </button>
          {/* 取り直しの promise をそのまま渡す。ボタンはこれが解決するまで
              待ち表示になる（移植元の _IconHit と同じ）。 */}
          <IconHitButton
            label={ja.homeRefreshLocation}
            busyLabel={ja.homeRefreshingLocation}
            onPress={refreshLocation}
          >
            <CompassIcon size={20} />
          </IconHitButton>
        </div>

        {/* デスクトップ幅では全画面の検索へ飛ばさず、その場で打って決める（#372）。
            これは見た目だけの差ではない——遷移が1つ消えるので CSS では表せない。 */}
        {isDesktop ? (
          <div className={styles.destinationField}>
            <span className={styles.placeLabel}>{ja.homeDestinationLabel}</span>
            <TypeaheadField
              store={store}
              mode="destination"
              places={deps.places}
              recents={deps.recents.destination}
              inputRef={destinationField}
            />
          </div>
        ) : (
          <div className={styles.placeRow}>
            <button
              type="button"
              className={styles.placeMain}
              aria-label={`${ja.homeDestinationLabel} ${destinationText}`}
              onClick={goSearch}
            >
              <span className={styles.placeLabel}>{ja.homeDestinationLabel}</span>
              <span
                className={`${styles.placeValue} ${destination === null ? styles.placeValuePlaceholder : ''}`}
              >
                {destinationText}
              </span>
            </button>
            <IconHitButton label={ja.homeSearchDestination} onPress={goSearch}>
              <span className={styles.searchChip}>
                <SearchIcon size={17} />
              </span>
            </IconHitButton>
          </div>
        )}
      </section>

      <section className={styles.timeSection}>
        <h2 className={styles.timeHeading}>
          <ClockIcon size={12} />
          <span className={styles.timeHeadingLabel}>
            {ja.homeTimeSectionLabel}
          </span>
          <span className={styles.budget}>
            <span className={styles.budgetValue}>
              {TimeValue.formatBudget(budgetMinutes(departure, arrival))}
            </span>
            {ja.homeWalkableSuffix}
          </span>
        </h2>
        <div className={`card ${styles.timeFields}`}>
          <TimeField
            store={store}
            mode={PickerMode.depart}
            label={ja.homeDepartureLabel}
            now={now}
          />
          <span className={styles.timeSeparator} aria-hidden="true">
            <ChevronIcon size={14} />
          </span>
          <TimeField
            store={store}
            mode={PickerMode.arrival}
            label={ja.homeArrivalLabel}
            now={now}
          />
        </div>
      </section>

      <div className={styles.spacer} />

      <ArukuButton
        className={styles.cta}
        label={ctaLabel(destination, onStartSearch)}
        icon={destination !== null ? <RoutesIcon size={20} /> : <SearchIcon size={19} />}
        disabled={destination !== null && onStartSearch === null}
        onPress={destination !== null ? (onStartSearch ?? noop) : goSearch}
      />
    </main>
  );
}

/// 目的地が決まっていなければ選びに行く CTA、決まっていれば検索の CTA。
/// ただし検索そのものがまだ無いときは、それが分かるラベルにする。
function ctaLabel(
  destination: string | null,
  onStartSearch: (() => void) | null,
): string {
  if (destination === null) return ja.homeChooseDestination;
  return onStartSearch === null ? ja.homeSearchRouteNotReady : ja.homeSearchRoute;
}

function noop(): void {}

