// 移植元: lib/features/result/result_screen.dart と result_totals.dart。
//
// 運んでいないもの（いずれも対になる相手が来てから）:
// - タイムラインの描画作り込み（result_timeline.dart、409 行）。区間は一覧で出す
// - 区間 CTA と外部地図への handoff（result_leg_cta.dart、238 行）。行程
//   （JourneyProgress）に依存し、それは歩数同期に依存する——#386 が UI ごと作らないと
//   決めた側
// - 共有（resultShareText）。外部連携で、経路検索の正しさとは独立
//
// ここが出すのは「現行 Web 版と結果を突き合わせられる」ための合計と区間。それが
// #386 の完了条件（経路検索が同じ結果を出す）に必要な最小限。

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { SegmentType, type RouteSegment } from '@aruku/engine/models/route-plan';
import { TimeValue } from '@aruku/engine/models/time-value';

import {
  ja,
  resultBudgetSummary,
  resultDepartureLabel,
  resultOverBudgetTitle,
  resultWalkRatioLabel,
} from '../../i18n/ja';
import { Screen } from '../../navigation/screens';
import { ArukuButton } from '../../shared/button';
import { ChevronIcon, ClockIcon, PinIcon, RoutesIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import styles from './result-screen.module.css';

interface ResultScreenProps {
  store: StoreApi<AppStore>;

  /// 日付の表示に使う現在時刻。テストで日付を固定できるよう注入可能にする。
  now?: () => Date;
}

export function ResultScreen({ store, now = () => new Date() }: ResultScreenProps) {
  const route = useStore(store, (s) => s.route);
  const departure = useStore(store, (s) => s.departure);
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
              こちらを使っている。PR #398 の Codex レビュー）。 */}
          {resultDepartureLabel(departure.fullDateLabel(now()), departure.format())}
        </p>
      </header>

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
        <ol className={styles.segmentList}>
          {route.segments.map((segment, index) => (
            <SegmentRow key={index} segment={segment} />
          ))}
        </ol>
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

function SegmentRow({ segment }: { segment: RouteSegment }) {
  return (
    <li className={styles.segment}>
      <span className={styles.segmentIcon} aria-hidden="true">
        {segment.type === SegmentType.walk ? <PinIcon size={16} /> : <ClockIcon size={16} />}
      </span>
      <span className={styles.segmentText}>
        <span className={styles.segmentNames}>
          {segment.fromName} → {segment.toName}
        </span>
        {segment.line !== null && (
          <span className={styles.segmentLine}>{segment.line}</span>
        )}
      </span>
      <span className={`tabular ${styles.segmentMinutes}`}>{segment.minutes}分</span>
    </li>
  );
}
