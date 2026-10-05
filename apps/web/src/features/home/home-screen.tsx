// 移植元: flutter-final:lib/features/home/home_screen.dart と home_widgets.dart。
//
// 週間目標カード（_WeeklyGoalCard / _WeeklyProgress / _TodayLine /
// _GoalRingPainter / _ActivityUnsupportedNote、約 280 行）は運んでいない。
// ブラウザに歩数 API が無く、加速度から自作してもタブが背面で止まるため、#386 が
// 「歩数まわりの導線は最初から作らない」と決めている。非対応の理由を出す注記も
// 一緒に消える——出す相手の機能が無い。
//
// 文字サイズは text-[12px] のように px の任意値で書く。text-xs のような名前付きは
// 行高も一緒に決め、行高 normal で組んだ移植元の寸法から行ごとに数 px ずれる。

import { useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { PickerMode, TimeValue } from '@aruku/engine/models/time-value';
import { budgetMinutes } from '@aruku/engine/services/route-plan-builder';

import { privacyPolicyUrl, termsOfServiceUrl } from '../../config';
import { todayGreeting } from '../../i18n/format';
import { useIsDesktop } from '../../layout/use-is-desktop';
import { useInitialLocation } from '../../location/use-initial-location';
import { ja } from '../../i18n/ja';
import type { ScreenDeps } from '../../navigation/screen-deps';
import { Screen } from '../../navigation/screens';
import { Button } from '../../shared/ui/button';
import { IconHitButton } from '../../shared/icon-hit-button';
import {
  ChevronIcon,
  ClockIcon,
  CompassIcon,
  PinIcon,
  RoutesIcon,
  SearchIcon,
} from '../../shared/icons';
import { TimeField } from '../picker/time-field';
import { TypeaheadField } from '../search/typeahead-field';
import { departureLabelText } from '../../state/derived';
import type { AppStore } from '../../state/store';
import { cn } from '../../shared/utils';

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
    <main className="mx-auto flex min-h-(--screen-min-height) max-w-[620px] flex-col gap-3 px-5 pt-2 pb-9">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink-2">{todayGreeting(now())}</p>
          <h1 className="mt-0.5 text-[26px] leading-[1.15] font-extrabold tracking-[-0.01em]">
            {ja.homeGreetingLead}
            <span className="text-moss-600">
              {ja.homeGreetingHighlight}
            </span>
          </h1>
        </div>
      </header>

      <section className="relative rounded-[22px] border border-border bg-card px-3.5 py-1.5 shadow-card-subtle">
        {/* 出発点と目的地を結ぶ線。移植元は Stack + Positioned で重ねている。 */}
        <span
          className="pointer-events-none absolute top-6 bottom-6 left-4 flex flex-col items-center text-burnt"
          aria-hidden="true"
        >
          <span className="size-2.5 rounded-full border-3 border-moss-100 bg-moss-500" />
          <span className="my-1 w-0.5 flex-1 bg-moss-200" />
          <PinIcon size={16} filled />
        </span>

        {/* 行の本体と末尾のアイコンは別の操作なので、入れ子にはできない（button の
            中に button は置けない）。横に並べる器で包む。 */}
        <div className="flex items-center gap-2">
          {/* 読み上げ名は aria-label で明示する。中身から組ませると、要素が横並びか
              縦積みかで語の区切りが変わる——見た目の都合が読み上げに漏れる。 */}
          <button
            type="button"
            className={placeMain}
            aria-label={`${ja.homeDepartureLabel} ${departureText}`}
            onClick={() => {
              go(Screen.searchOrigin);
            }}
          >
            <span className={placeLabel}>{ja.homeDepartureLabel}</span>
            <span className={placeValue}>{departureText}</span>
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
          // ラベルは行の上に置き、欄そのものは TypeaheadField が持つ。
          <div className="flex flex-col gap-1.5 pt-2 pb-3 pl-[38px]">
            <span className={placeLabel}>{ja.homeDestinationLabel}</span>
            <TypeaheadField
              store={store}
              mode="destination"
              places={deps.places}
              recents={deps.recents.destination}
              inputRef={destinationField}
            />
          </div>
        ) : (
          // 区切り線は出発の行との間にだけ引く。デスクトップ幅の欄には引かない。
          <div className="flex items-center gap-2 border-t border-hairline">
            <button
              type="button"
              className={placeMain}
              aria-label={`${ja.homeDestinationLabel} ${destinationText}`}
              onClick={goSearch}
            >
              <span className={placeLabel}>{ja.homeDestinationLabel}</span>
              <span
                className={cn(
                  placeValue,
                  destination === null && 'font-semibold text-ink-3',
                )}
              >
                {destinationText}
              </span>
            </button>
            <IconHitButton label={ja.homeSearchDestination} onPress={goSearch}>
              <span className="inline-flex size-9 items-center justify-center rounded-[11px] bg-moss-50 text-moss-600">
                <SearchIcon size={17} />
              </span>
            </IconHitButton>
          </div>
        )}
      </section>

      <section className="mt-6">
        {/* 上下の余白は h2 の UA 既定（0.83em）。preflight が 0 に均すので明示して保つ。 */}
        <h2 className="my-[0.83em] flex items-center gap-[5px] px-1 pb-2 text-[11px] font-extrabold tracking-[0.08em] text-ink-2">
          <ClockIcon size={12} />
          <span className="min-w-0 flex-1">
            {ja.homeTimeSectionLabel}
          </span>
          <span className="text-end font-semibold tracking-normal">
            <span className="font-extrabold text-moss-600">
              {TimeValue.formatBudget(budgetMinutes(departure, arrival))}
            </span>
            {ja.homeWalkableSuffix}
          </span>
        </h2>
        <div className="flex items-stretch rounded-md border border-border bg-card p-1.5">
          <TimeField
            store={store}
            mode={PickerMode.depart}
            label={ja.homeDepartureLabel}
            now={now}
          />
          <span className="flex w-7 items-center text-ink-3" aria-hidden="true">
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

      {/* 目標カードを作らないぶん、CTA は下端へ寄せる（移植元の Spacer の位置）。 */}
      <div className="min-h-6 flex-1" />

      <Button
        className="min-h-15 rounded-[20px] text-[18px] tracking-[0.06em] shadow-cta-primary"
        disabled={destination !== null && onStartSearch === null}
        onClick={destination !== null ? (onStartSearch ?? noop) : goSearch}
      >
        {destination !== null ? <RoutesIcon size={20} /> : <SearchIcon size={19} />}
        {ctaLabel(destination, onStartSearch)}
      </Button>

      {/* <footer> にしない。<main> の中の <footer> は実ブラウザでは contentinfo の
          ランドマークにならず（jsdom はなる）、読み上げから辿れない。 */}
      <nav className="flex justify-center gap-4" aria-label={ja.legalSection}>
        <LegalLink label={ja.legalTermsOfService} href={termsOfServiceUrl} />
        <LegalLink label={ja.legalPrivacyPolicy} href={privacyPolicyUrl} />
      </nav>
    </main>
  );
}

const placeMain =
  'min-w-0 flex-1 cursor-pointer rounded-sm py-3 pr-0 pl-[38px] text-start';
const placeLabel = 'block text-[12px] font-bold tracking-[0.06em] text-ink-2';
const placeValue = 'mt-0.5 block text-[16px] font-bold text-ink';

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

function LegalLink({ label, href }: { label: string; href: string }) {
  return (
    // rel は target=_blank の暗黙の noopener に任せない。明示しない <a> は、開いた先から
    // window.opener 越しにこちらを操作できる実装が残っている。
    <a
      className="inline-flex min-h-tap-min items-center px-1 text-[12px] font-semibold text-ink-3 underline-offset-2 hover:underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label}
    </a>
  );
}

