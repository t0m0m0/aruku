// 移植元: flutter-final:lib/features/result/result_screen.dart と result_totals.dart。
// タイムラインは result-timeline.tsx にある。
//
// 運んでいないもの（いずれも対になる相手が来てから）:
// - 区間 CTA の行程まわり（result_leg_cta.dart の完了表示・手動完了）。行程
//   （JourneyProgress）に依存し、それは歩数同期に依存する——#386 が UI ごと作らないと
//   決めた側。外部地図への引き継ぎだけは行程から切り離し、result-timeline.tsx の
//   区間ごとに置いた（#449）
// - 共有（resultShareText）。外部連携で、経路検索の正しさとは独立

import { useId } from 'react';
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
  resultCalories,
  resultDepartureLabel,
  resultExtraWalk,
  resultOverBudgetTitle,
  resultSlack,
  resultStandardDetail,
} from '../../i18n/ja';
import { useIsDesktop } from '../../layout/use-is-desktop';
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
  const isDesktop = useIsDesktop();

  // ガードが通す以上ここへは経路付きでしか来ないが、欠けていても空の画面を見せない。
  if (route === null) {
    return (
      <main className="flex min-h-(--screen-min-height) flex-col items-center justify-center gap-4 bg-surface p-6 text-on-surface-variant">
        <RoutesIcon size={32} />
        <p className="text-title-medium">{ja.resultNoRouteMessage}</p>
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

  const overBudget = route.totalMin > route.budgetMin;

  // 経路全体を俯瞰する固定高のプレビュー。代替案の切り替えで route が差し替わると
  // ArukuMap 側が矩形の変化を見てカメラを合わせ直す。移植元 _RouteMapPreview の
  // ClipRRect + SizedBox(height: 180)。角丸は移植元の 16px ではなく M3 のカードの
  // medium（12px）に揃えている。
  //
  // デスクトップ幅では右カラム全面。固定高と角丸は俯瞰用の 180px の枠に対するもの。
  const map = (
    <div
      className="h-[180px] flex-none overflow-hidden rounded-medium desktop:[grid-area:1/2/3/3] desktop:h-auto desktop:rounded-none"
      data-testid="result-map"
    >
      <ArukuMap route={route} />
    </div>
  );

  return (
    <main className="flex min-h-(--screen-min-height) flex-col gap-4 bg-surface px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-on-surface desktop:grid desktop:h-(--screen-min-height) desktop:min-h-0 desktop:grid-cols-[380px_1fr] desktop:grid-rows-[auto_1fr] desktop:gap-0 desktop:p-0">
      {/* 戻るボタンの左に余白を足さず -ml-3 で引くのは、48px の当たり領域の中でアイコンを
          本文の左端（ページの余白 16px）に揃えるため。 */}
      <header className="-ml-3 flex min-h-16 items-center gap-1 desktop:[grid-area:1/1] desktop:ml-0 desktop:border-r desktop:border-b desktop:border-outline-variant desktop:px-1">
        <button
          type="button"
          className="grid size-12 flex-none cursor-pointer place-items-center rounded-full text-on-surface hover:bg-on-surface/8"
          aria-label={ja.commonBack}
          onClick={() => {
            go(Screen.home);
          }}
        >
          <ChevronIcon size={20} dir="left" />
        </button>
        <p className="text-title-medium">
          {/* 基準は描画時刻ではなく state の dateBasis。固定出発の経路は routeAsOf を
              持たない＝失効しないので、日を跨いでも開いたまま残る——描画時刻から
              数えると、旅程は変わっていないのに日付だけ1日進む
              （PR #399 の Codex レビュー）。 */}
          {resultDepartureLabel(departure.fullDateLabel(dateBasis), departure.format())}
        </p>
      </header>

      {/* 置き場所を幅で分けるのは CSS の order では足りないため。モバイル幅では行程と
          補助情報のあいだに挟まるが、デスクトップ幅の地図は右カラム全面で、パネルの中に
          置くとパネルと一緒にスクロールする。order で見た目だけ動かすと、読み上げと
          Tab の順が地図→行程のまま残る。 */}
      {isDesktop && map}

      {/* ヘッダから下をひとまとめにする。デスクトップ幅ではここだけが内部スクロール
          する左パネルになり、ヘッダと地図は動かない。モバイル幅では画面の縦積みの一部で、
          間隔は main の gap と揃える。 */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 desktop:[grid-area:2/1] desktop:overflow-y-auto desktop:border-r desktop:border-outline-variant desktop:p-4"
        data-testid="result-panel"
      >
        {overBudget && (
          <section className="rounded-medium bg-error-container p-4 text-on-error-container" role="status">
            <p className="text-title-medium">
              {resultOverBudgetTitle(route.totalMin - route.budgetMin)}
            </p>
            <p className="mt-1 text-body-medium">{ja.resultOverBudgetHint}</p>
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

        <section>
          <h2 className="mb-2 text-title-small text-on-surface-variant">{ja.resultSegmentsHeading}</h2>
          <ResultTimeline route={route} />
        </section>

        {!isDesktop && map}

        <RouteAuxiliary route={route} departure={departure} overBudget={overBudget} />
      </div>
    </main>
  );
}

/// ルートを決めたあとで気になる人が読む情報。行程と同じ事実の言い換えなので、
/// 行程より上には置かない（#453）。
function RouteAuxiliary({
  route,
  departure,
  overBudget,
}: {
  route: RoutePlan;
  departure: TimeValue;
  overBudget: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="border-t border-outline-variant pt-4">
      <h2 id={headingId} className="pb-1 text-title-small text-on-surface-variant">
        {ja.resultAuxiliaryHeading}
      </h2>
      <ul>
        {/* 超過時は最短へ縮退した経路を出している。歩けた量を誇る場面ではなく、
            余裕は無い——それは警告が言う。 */}
        {!overBudget && <ExtraWalkSummary route={route} departure={departure} />}
        {!overBudget && (
          <AuxiliaryItem>
            {resultSlack(
              formatClock(departure, route.budgetMin),
              TimeValue.formatBudget(route.budgetMin - route.totalMin),
            )}
          </AuxiliaryItem>
        )}
        <AuxiliaryItem>{resultCalories(route.kcal)}</AuxiliaryItem>
      </ul>
    </section>
  );
}

/// M3 のリスト項目。1行なら 56px、補足を伴えば中身なりに伸びる。左右の余白を持たない
/// のは、ページの余白（16px）が M3 のリストの内側の余白と同じ値だから。
function AuxiliaryItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex min-h-14 flex-col justify-center py-2 text-body-large">{children}</li>
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
    <AuxiliaryItem>
      <p className="text-label-medium text-on-surface-variant">{ja.resultStandardLead}</p>
      <p className="tabular">{resultExtraWalk(TimeValue.formatBudget(extra))}</p>
      <p className="text-body-medium text-on-surface-variant">
        {resultStandardDetail(
          formatClock(departure, standard.totalMin),
          standard.walkMinutes,
        )}
      </p>
    </AuxiliaryItem>
  );
}
