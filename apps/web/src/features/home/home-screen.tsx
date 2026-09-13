// 移植元: lib/features/home/home_screen.dart と home_widgets.dart。
//
// 週間目標カード（_WeeklyGoalCard / _WeeklyProgress / _TodayLine /
// _GoalRingPainter / _ActivityUnsupportedNote、約 280 行）は運んでいない。
// ブラウザに歩数 API が無く、加速度から自作してもタブが背面で止まるため、#386 が
// 「歩数まわりの導線は最初から作らない」と決めている。非対応の理由を出す注記も
// 一緒に消える——出す相手の機能が無い。
//
// 時刻フィールドは表示だけで、押しても開かない。日時ピッカーが未移植のため、
// 押せる見た目にすると何も起きないボタンになる。ピッカーのスライスで押下を足す。

import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { TimeValue } from '@aruku/engine/models/time-value';
import { budgetMinutes } from '@aruku/engine/services/route-plan-builder';

import { todayGreeting } from '../../i18n/format';
import { ja } from '../../i18n/ja';
import { Screen } from '../../navigation/screens';
import { ArukuButton } from '../../shared/button';
import {
  ChevronIcon,
  ClockIcon,
  CompassIcon,
  PinIcon,
  RoutesIcon,
  SearchIcon,
  SettingsIcon,
} from '../../shared/icons';
import { departureLabelText } from '../../state/derived';
import type { AppStore } from '../../state/store';
import styles from './home-screen.module.css';

interface HomeScreenProps {
  store: StoreApi<AppStore>;

  /// 経路検索の開始。目的地が決まっているときの CTA から呼ぶ。
  onStartSearch: () => void;

  /// 挨拶に使う現在時刻。テストで時刻帯を固定できるよう注入可能にする。
  now?: () => Date;
}

export function HomeScreen({
  store,
  onStartSearch,
  now = () => new Date(),
}: HomeScreenProps) {
  const origin = useStore(store, (s) => s.origin);
  const destination = useStore(store, (s) => s.destination);
  const departure = useStore(store, (s) => s.departure);
  const arrival = useStore(store, (s) => s.arrival);
  const locationState = useStore(store, (s) => s.locationState);
  const go = useStore(store, (s) => s.go);
  const refreshLocation = useStore(store, (s) => s.refreshLocation);

  // 移植元は AppNotifier.build() で取りに行っていた。ストア生成時に呼ぶと、
  // モジュール読み込みだけで権限ダイアログが出る（store.ts の注記を参照）。
  //
  // まだ一度も取っていないときだけ走らせる。この画面は子画面から戻るたびに
  // 再マウントされるので、素通しすると戻るたびに測位し、一度きりの許可を使う
  // ブラウザでは毎回ダイアログが出る（PR #394 レビュー）。取り直しはコンパスと
  // いう明示の導線がある。
  //
  // 判定はストアから直に読む。locationState を依存に入れると、取得の完了で
  // 効果自体が再実行される——「一度だけ」を状態の変化で壊すことになる。
  useEffect(() => {
    const { locationState: current, refreshLocation: refresh } = store.getState();
    if (current.kind !== 'loading') return;
    void refresh();
  }, [store]);

  const goSearch = () => {
    go(Screen.search);
  };

  const departureText = departureLabelText(origin, locationState);
  const destinationText = destination ?? ja.homeDestinationPlaceholder;

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.greeting}>
          <p className={styles.greetingDate}>{todayGreeting(now())}</p>
          <p className={styles.greetingLead}>
            {ja.homeGreetingLead}
            <span className={styles.greetingHighlight}>
              {ja.homeGreetingHighlight}
            </span>
          </p>
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
          <button
            type="button"
            className={styles.iconHit}
            aria-label={ja.homeRefreshLocation}
            onClick={() => {
              void refreshLocation();
            }}
          >
            <CompassIcon size={20} />
          </button>
        </div>

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
          <button
            type="button"
            className={styles.iconHit}
            aria-label={ja.homeSearchDestination}
            onClick={goSearch}
          >
            <span className={styles.searchChip}>
              <SearchIcon size={17} />
            </span>
          </button>
        </div>
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
          <TimeField label={ja.homeDepartureLabel} time={departure} />
          <span className={styles.timeSeparator} aria-hidden="true">
            <ChevronIcon size={14} />
          </span>
          <TimeField label={ja.homeArrivalLabel} time={arrival} />
        </div>
      </section>

      <div className={styles.spacer} />

      <ArukuButton
        className={styles.cta}
        label={destination !== null ? ja.homeSearchRoute : ja.homeChooseDestination}
        icon={destination !== null ? <RoutesIcon size={20} /> : <SearchIcon size={19} />}
        onPress={destination !== null ? onStartSearch : goSearch}
      />
    </main>
  );
}

function TimeField({ label, time }: { label: string; time: TimeValue }) {
  const date = time.dateLabel();
  return (
    <div className={styles.timeField}>
      <span className={styles.timeLabel}>{label}</span>
      {date !== null && <span className={styles.timeDate}>{date}</span>}
      <span className={`tabular ${styles.timeValue}`}>{time.format()}</span>
    </div>
  );
}
