// 移植元: lib/features/result/result_screen.dart と result_totals.dart。
// タイムラインは result-timeline.tsx にある。
//
// 運んでいないもの（いずれも対になる相手が来てから）:
// - 区間 CTA と外部地図への handoff（result_leg_cta.dart、238 行）。行程
//   （JourneyProgress）に依存し、それは歩数同期に依存する——#386 が UI ごと作らないと
//   決めた側
// - 共有（resultShareText）。外部連携で、経路検索の正しさとは独立

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { TimeValue } from '@aruku/engine/models/time-value';

import {
  ja,
  resultBudgetSummary,
  resultDepartureLabel,
  resultOverBudgetTitle,
  resultWalkRatioLabel,
} from '../../i18n/ja';
import { ArukuMap } from '../../map/aruku-map';
import { Screen } from '../../navigation/screens';
import { ArukuButton } from '../../shared/button';
import { ChevronIcon, RoutesIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import styles from './result-screen.module.css';
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
      <main className={styles.empty}>
        <RoutesIcon size={32} />
        <p className={styles.emptyMessage}>{ja.resultNoRouteMessage}</p>
        <ArukuButton
          label={ja.resultBackToSearch}
          onPress={() => {
            go(Screen.search);
          }}
        />
      </main>
    );
  }

  const slack = route.budgetMin - route.totalMin;
  const overBudget = route.totalMin > route.budgetMin;

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          aria-label={ja.commonBack}
          onClick={() => {
            go(Screen.home);
          }}
        >
          <ChevronIcon size={20} dir="left" />
        </button>
        <p className={styles.departure}>
          {/* dateLabel ではなく fullDateLabel。前者は home 用で当日を null・翌日を
              「明日」にするが、結果では実際に検索した日付を常に出したい（移植元も
              こちらを使っている。PR #398 の Codex レビュー）。

              基準は描画時刻ではなく state の dateBasis。固定出発の経路は routeAsOf を
              持たない＝失効しないので、日を跨いでも開いたまま残る——描画時刻から
              数えると、旅程は変わっていないのに日付だけ1日進む
              （PR #399 の Codex レビュー）。 */}
          {resultDepartureLabel(departure.fullDateLabel(dateBasis), departure.format())}
        </p>
      </header>

      {/* 経路全体を俯瞰する固定高のプレビュー。代替案の切り替えで route が差し替わると
          ArukuMap 側が矩形の変化を見てカメラを合わせ直す。 */}
      <div className={styles.map} data-testid="result-map">
        <ArukuMap route={route} />
      </div>

      <section className={`card ${styles.totals}`}>
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

      <section className={styles.ratio}>
        <p className={styles.ratioLabel}>
          {resultWalkRatioLabel(Math.round(route.walkRatio * 100))}
        </p>
        <p className={styles.ratioSummary}>
          {resultBudgetSummary(
            TimeValue.formatBudget(route.budgetMin),
            TimeValue.formatBudget(route.totalMin),
            Math.abs(slack),
            overBudget,
          )}
        </p>
      </section>

      {overBudget && (
        <section className={styles.overBudget} role="status">
          <p className={styles.overBudgetTitle}>
            {resultOverBudgetTitle(route.totalMin - route.budgetMin)}
          </p>
          <p className={styles.overBudgetHint}>{ja.resultOverBudgetHint}</p>
          <ArukuButton
            className={styles.overBudgetAction}
            variant="outlined"
            label={ja.resultChangeConditions}
            onPress={() => {
              go(Screen.home);
            }}
          />
        </section>
      )}

      <section className={styles.segments}>
        <h2 className={styles.segmentsHeading}>{ja.resultSegmentsHeading}</h2>
        <ResultTimeline route={route} />
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={`tabular ${styles.metricValue}`}>{value}</span>
    </div>
  );
}
