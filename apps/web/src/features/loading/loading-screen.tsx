// 移植元: flutter-final:lib/features/loading/loading_screen.dart

import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { TimeValue } from '@aruku/engine/models/time-value';
import { budgetMinutes } from '@aruku/engine/services/route-plan-builder';
import { RoutePhase } from '@aruku/engine/services/route-service';

import { ja } from '../../i18n/ja';
import { ArukuMap } from '../../map/aruku-map';
import { Button } from '../../shared/ui/button';
import type { AppStore } from '../../state/store';

/// 段階ごとに保証する塗り率の下限。
///
/// 時間ランプだけだと段階が進んでも見た目が変わらず、進んだことが伝わらない。
/// 1 にしないのは、満タンが「完了」を意味してしまうため——完了で起きるのは
/// 画面遷移であって塗り切りではない。
const floors: Readonly<Record<RoutePhase, number>> = {
  [RoutePhase.routing]: 0,
  [RoutePhase.walkability]: 0.55,
  [RoutePhase.building]: 0.95,
};

export function progressFloor(phase: RoutePhase | null): number {
  return phase === null ? floors[RoutePhase.routing] : floors[phase];
}

/// 時間ランプの漸近上限。完了（画面遷移）まで満タンにはしない。
const asymptote = 0.9;

/// 時間ランプの時定数（秒）。小さいほど序盤が速い。
const rampTau = 6;

/// 指数追従の時定数（ミリ秒）。現在値が目標へ寄る速さ。
const chaseTau = 250;

// 離脱時の中断はこの画面が持たない。アンマウントを合図にすると StrictMode の
// 二重マウントで本物の検索を殺すため、ルーターの購読へ出してある
// （navigation/search-abandon.ts）。
interface LoadingScreenProps {
  store: StoreApi<AppStore>;
}

export function LoadingScreen({ store }: LoadingScreenProps) {
  const destination = useStore(store, (s) => s.destination);
  const departure = useStore(store, (s) => s.departure);
  const arrival = useStore(store, (s) => s.arrival);
  const routePhase = useStore(store, (s) => s.routePhase);
  const cancelSearch = useStore(store, (s) => s.cancelSearch);

  const progress = useRampedProgress(progressFloor(routePhase));

  const budget = TimeValue.formatBudgetJp(budgetMinutes(departure, arrival));
  const subtitle =
    destination !== null && destination !== ''
      ? `${destination} まで · 制限 ${budget}`
      : `制限 ${budget}`;
  const percent = Math.round(progress * 100);

  return (
    <main className="relative flex min-h-(--screen-min-height) flex-col items-center justify-center gap-7 overflow-hidden p-6">
      {/* 地図を敷いた背景。装飾であって進捗の一部ではないので、読み上げへは出さない。
          経路はまだ出ていないので描かない（移植元も ArukuMap(showRoute: false)）。

          aria-hidden だけでは足りず inert も要る。実キーがあるとここは本物の地図になり、
          canvas と Google が差し込む帰属表示のリンクはフォーカスを受け、ジェスチャーは
          入力を飲む——読み上げから隠れたままタブで入れる的が残る。pointer-events-none は
          inert に対応していないブラウザでも背景のジェスチャーを止めるため。

          彩度は移植元の ColorFilter.matrix（3x3 で彩度を落として少し暖色へ寄せる）と
          小数第2位で違う。CSS で任意の行列を当てるには filter: url() で SVG を1枚挟むしか
          なく、0.35 の不透明度とベールの下に敷く絵の差としては釣り合わない。 */}
      <div
        className="pointer-events-none absolute inset-0 opacity-35 saturate-70"
        data-testid="loading-map"
        aria-hidden="true"
        inert
      >
        <ArukuMap showRoute={false} />
      </div>
      {/* 中心を抜いて周縁を ivory で覆う。移植元の RadialGradient（radius 0.7）相当。 */}
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgb(251_252_236/0)_0%,var(--color-ivory)_70%)]"
        aria-hidden="true"
      />

      <div className="relative flex w-full max-w-80 flex-col items-center gap-2.5 text-center">
        {/* 減光設定では止める。 */}
        <span
          className="mb-[18px] size-30 animate-pulse-ring rounded-full bg-moss-100 motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="text-[13px] font-semibold text-ink-3">{subtitle}</p>
        <p className="text-[18px] font-bold text-ink">{ja.loadingSearchingMessage}</p>

        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sand"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={ja.loadingSearchingMessage}
        >
          <span className="block h-full rounded-full bg-moss-500" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <Button className="relative max-w-80" variant="outline" onClick={cancelSearch}>
        {ja.loadingCancelButton}
      </Button>
    </main>
  );
}

/// 時間で伸びつつ、段階の下限を必ず満たす塗り率（0..1）。
///
/// 移植元の Ticker を requestAnimationFrame に置き換えたもの。式は同じで、
/// 「時間ランプと下限の大きいほうを目標に、指数で追従する」。
function useRampedProgress(floor: number): number {
  const [value, setValue] = useState(0);
  // 目標はフレームごとに読み直す。依存に入れて効果を張り直すと、段階が変わるたびに
  // 経過時間が 0 へ戻り、ランプが伸び直してしまう。
  const floorRef = useRef(floor);
  floorRef.current = floor;

  useEffect(() => {
    // jsdom や、アニメーションを持たない環境では伸ばさない。下限そのものは
    // 初期値として下で反映する。
    if (typeof requestAnimationFrame !== 'function') return;

    let frame = 0;
    let startedAt: number | null = null;
    let last: number | null = null;
    let current = 0;

    const tick = (at: number) => {
      startedAt ??= at;
      const dtMs = last === null ? 0 : at - last;
      last = at;

      const seconds = (at - startedAt) / 1000;
      const ramp = asymptote * (1 - Math.exp(-seconds / rampTau));
      const target = Math.max(ramp, floorRef.current);
      const k = 1 - Math.exp(-dtMs / chaseTau);
      current += (target - current) * k;
      setValue(current);

      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return Math.max(value, floor);
}
