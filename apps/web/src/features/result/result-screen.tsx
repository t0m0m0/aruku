// 移植元: flutter-final:lib/features/result/result_screen.dart と result_totals.dart。
// タイムラインは result-timeline.tsx にある。
//
// 運んでいないもの（いずれも対になる相手が来てから）:
// - 区間 CTA の行程まわり（result_leg_cta.dart の完了表示・手動完了）。行程
//   （JourneyProgress）に依存し、それは歩数同期に依存する——#386 が UI ごと作らないと
//   決めた側。外部地図への引き継ぎだけは行程から切り離し、result-timeline.tsx の
//   区間カードに置いた（#449）
// - 共有（resultShareText）。外部連携で、経路検索の正しさとは独立

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import {
  SegmentType,
  type RoutePlan,
} from '@aruku/engine/models/route-plan';
import { TimeValue } from '@aruku/engine/models/time-value';
import { formatClock } from '@aruku/engine/services/route-plan-builder';

import {
  ja,
  resultBudgetSummary,
  resultDepartureLabel,
  resultExtraWalk,
  resultOverBudgetTitle,
  resultStandardDetail,
  resultWalkRatioLabel,
} from '../../i18n/ja';
import { ArukuMap } from '../../map/aruku-map';
import { Screen } from '../../navigation/screens';
import { Button } from '../../shared/ui/button';
import { ChevronIcon, RoutesIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import { ResultTimeline } from './result-timeline';

interface ResultScreenProps {
  store: StoreApi<AppStore>;
}

// 現在時刻は受け取らない。この画面が出す日付は「いつ描いたか」ではなく「どの基準で
// 数えた予定か」で決まり、それは state の dateBasis が持っている。注入口を残すと、
// テストが制御しているつもりで何も制御していない引数になる。
export function ResultScreen({ store }: ResultScreenProps) {
  const route = useStore(store, (s) => s.route);
  const departure = useStore(store, (s) => s.departure);
  const dateBasis = useStore(store, (s) => s.dateBasis);
  const go = useStore(store, (s) => s.go);

  // ガードが通す以上ここへは経路付きでしか来ないが、欠けていても空の画面を見せない。
  if (route === null) {
    return (
      <main className="flex min-h-(--screen-min-height) flex-col items-center justify-center gap-3.5 p-6 text-ink-3">
        <RoutesIcon size={32} />
        <p className="text-[15px] font-semibold">{ja.resultNoRouteMessage}</p>
        <Button
          onClick={() => {
            go(Screen.search);
          }}
        >
          {ja.resultBackToSearch}
        </Button>
      </main>
    );
  }

  const slack = route.budgetMin - route.totalMin;
  const overBudget = route.totalMin > route.budgetMin;

  return (
    // デスクトップ幅は移植元 result_screen.dart の分岐（splitPanelWidth 380）。左パネルは
    // ビューポート内に収め、内側だけをスクロールさせる。一括スクロールにすると下部の
    // 導線がビューポート固定の分割ビューから押し出される（#262）。
    <main className="flex min-h-(--screen-min-height) flex-col gap-3.5 px-[18px] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] desktop:grid desktop:h-(--screen-min-height) desktop:min-h-0 desktop:grid-cols-[380px_1fr] desktop:grid-rows-[auto_1fr] desktop:gap-0 desktop:p-0">
      <header className="flex items-center gap-1.5 pt-1 desktop:[grid-area:1/1] desktop:border-r desktop:border-b desktop:border-hairline desktop:bg-paper desktop:px-[22px] desktop:pt-[18px] desktop:pb-3.5">
        <button
          type="button"
          className="grid size-10 flex-none cursor-pointer place-items-center rounded-sm text-ink"
          aria-label={ja.commonBack}
          onClick={() => {
            go(Screen.home);
          }}
        >
          <ChevronIcon size={20} dir="left" />
        </button>
        <p className="text-[13px] font-semibold text-ink-3">
          {/* 基準は描画時刻ではなく state の dateBasis。固定出発の経路は routeAsOf を
              持たない＝失効しないので、日を跨いでも開いたまま残る——描画時刻から
              数えると、旅程は変わっていないのに日付だけ1日進む
              （PR #399 の Codex レビュー）。 */}
          {resultDepartureLabel(departure.fullDateLabel(dateBasis), departure.format())}
        </p>
      </header>

      {/* 経路全体を俯瞰する固定高のプレビュー。代替案の切り替えで route が差し替わると
          ArukuMap 側が矩形の変化を見てカメラを合わせ直す。移植元 _RouteMapPreview の
          ClipRRect + SizedBox(height: 180)。角丸 16px はトークンに無い（sm 12 / md 18）ので
          移植元の BorderRadius.circular(16) をそのまま置く。

          デスクトップ幅では右カラム全面。固定高と角丸は俯瞰用の 180px の枠に対するもの。 */}
      <div
        className="h-[180px] flex-none overflow-hidden rounded-[16px] desktop:[grid-area:1/2/3/3] desktop:h-auto desktop:rounded-none"
        data-testid="result-map"
      >
        <ArukuMap route={route} />
      </div>

      {/* 合計から下をひとまとめにする。デスクトップ幅ではここだけが内部スクロール
          する左パネルになり、ヘッダと地図は動かない。モバイル幅では画面の縦積みの一部で、
          間隔は main の gap と揃える——包む要素が増えても `< 820px` の見た目が変わらない
          ことが条件（#406）。 */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-3.5 desktop:[grid-area:2/1] desktop:overflow-y-auto desktop:border-r desktop:border-hairline desktop:bg-paper desktop:px-[18px] desktop:py-3.5"
        data-testid="result-panel"
      >
        {!overBudget && (
          <ExtraWalkSummary route={route} departure={departure} />
        )}

        <section className="grid grid-cols-3 gap-2 rounded-md border border-border bg-card px-3.5 py-4">
          <Metric
            label={ja.resultMetricDuration}
            value={TimeValue.formatBudget(route.totalMin)}
          />
          <Metric
            label={ja.resultMetricWalkDistance}
            value={`${route.walkKm.toFixed(1)} km`}
          />
          <Metric label={ja.resultMetricCalories} value={`${route.kcal} kcal`} />
        </section>

        <section className="px-1">
          <p className="text-[12px] font-extrabold text-ink">
            {resultWalkRatioLabel(Math.round(route.walkRatio * 100))}
          </p>
          <p className="mt-0.5 text-[11px] font-medium text-ink-3">
            {resultBudgetSummary(
              TimeValue.formatBudget(route.budgetMin),
              TimeValue.formatBudget(route.totalMin),
              Math.abs(slack),
              overBudget,
            )}
          </p>
        </section>

        {overBudget && (
          <section className="rounded-sm bg-burnt-soft p-3.5" role="status">
            <p className="text-[13px] font-bold text-burnt">
              {resultOverBudgetTitle(route.totalMin - route.budgetMin)}
            </p>
            <p className="mt-1 text-[12px] font-medium text-ink-3">{ja.resultOverBudgetHint}</p>
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => {
                go(Screen.home);
              }}
            >
              {ja.resultChangeConditions}
            </Button>
          </section>
        )}

        <section className="flex-1">
          <h2 className="mx-1 mb-1.5 text-[12px] font-bold text-ink-3">{ja.resultSegmentsHeading}</h2>
          <ResultTimeline route={route} />
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span className="text-[11px] font-semibold text-ink-3">{label}</span>
      <span className="tabular text-[17px] font-extrabold text-ink">{value}</span>
    </div>
  );
}

/// ふつうの乗換ルートの徒歩は上流の見積りのままで、確定経路は街路実測（RoutePlan の
/// standardTransit の注記）。これより小さい差は誤差と見分けられない。
const minExtraWalkToShow = 5;

function ExtraWalkSummary({
  route,
  departure,
}: {
  route: RoutePlan;
  departure: TimeValue;
}) {
  const standard = route.standardTransit;
  if (standard === null) return null;
  const walkMinutes = route.segments
    .filter((s) => s.type === SegmentType.walk)
    .reduce((a, s) => a + s.minutes, 0);
  const extra = walkMinutes - standard.walkMinutes;
  if (extra < minExtraWalkToShow) return null;

  return (
    <section className="rounded-md bg-moss-50 px-4 py-3">
      <p className="text-[12px] font-semibold text-moss-600">{ja.resultStandardLead}</p>
      <p className="tabular text-[22px] font-extrabold text-moss-700">
        {resultExtraWalk(TimeValue.formatBudget(extra))}
      </p>
      <p className="mt-0.5 text-[11px] font-medium text-ink-3">
        {resultStandardDetail(
          formatClock(departure, standard.totalMin),
          standard.walkMinutes,
        )}
      </p>
    </section>
  );
}
