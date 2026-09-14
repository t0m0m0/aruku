// 移植元: lib/features/result/result_timeline.dart。
//
// journey 進捗（#305 の _LegState と _LegStateBadge）は運んでいない。JourneyProgress は
// 歩数同期に依存し、#386 が Web で作らないと決めた側——移植元で言えば journey==null の
// _LegState.none だけが残る。
//
// 図案の戻り先は Dart の Canvas 命令ではなく design_handoff_aruku_mvp/design-reference/
// screens-result.jsx。Dart 版はそれを Canvas へ移したもので、そこから起こし直すと
// 二重の写しになる（src/shared/icons.tsx 冒頭と同じ理由）。

import {
  SegmentType,
  type RoutePlan,
  type RouteSegment,
  type TimelineNode,
} from '@aruku/engine/models/route-plan';

import { ja, resultLegKcal, resultSegmentDuration } from '../../i18n/ja';
import { TrainIcon, WalkIcon } from '../../shared/icons';
import styles from './result-timeline.module.css';

interface ResultTimelineProps {
  route: RoutePlan;
}

/// ノードと区間カードを交互に積む。両者の 1:1 対応は route-plan-builder が組み立てる
/// （「segments と timelineNodes の 1:1 対応を保つ」）ので、ここでは崩さないことだけを見る。
export function ResultTimeline({ route }: ResultTimelineProps) {
  const segments = route.segments;
  const steps: { node: TimelineNode; segment: RouteSegment | null; connector: boolean }[] = [];

  // cardBelow:false の駅行（直結乗換の「着」行）はカードを挟まず、次の「発」行へ短い
  // コネクタで繋ぐ。それ以外の行は順にレッグカードを 1 枚消費する。ノードは常に区間より
  // 多い（末尾の到着ノードが余る）ので、使い切ったあとは置かない。
  let cursor = 0;
  route.timelineNodes.forEach((node, index) => {
    const isLast = index === route.timelineNodes.length - 1;
    if (node.cardBelow && cursor < segments.length) {
      steps.push({ node, segment: segments[cursor], connector: false });
      cursor += 1;
    } else {
      steps.push({ node, segment: null, connector: !node.cardBelow && !isLast });
    }
  });

  return (
    <ol className={styles.timeline}>
      {steps.map(({ node, segment, connector }, index) => (
        <li key={index} className={styles.step}>
          <span className={`tabular ${styles.time}`}>{node.time}</span>
          <span className={styles.nodeTrack} aria-hidden="true">
            <span className={styles.dot} />
          </span>
          <span className={styles.nodeText}>
            <span className={styles.place}>{node.place}</span>
            {node.sub !== '' && <span className={styles.sub}>{node.sub}</span>}
          </span>
          {segment !== null && <Leg segment={segment} />}
          {connector && <span className={styles.connector} aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function Leg({ segment }: { segment: RouteSegment }) {
  const isWalk = segment.type === SegmentType.walk;
  return (
    <>
      <span
        className={`${styles.legTrack} ${isWalk ? styles.trackWalk : styles.trackRide}`}
        aria-hidden="true"
      />
      <div className={`${styles.card} ${isWalk ? styles.cardWalk : styles.cardRide}`}>
        <div className={styles.cardHead}>
          <span className={styles.legIcon} aria-hidden="true">
            {isWalk ? <WalkIcon size={16} /> : <TrainIcon size={16} />}
          </span>
          <span className={styles.legLabel}>{legLabel(segment)}</span>
          <span className={styles.duration}>
            {resultSegmentDuration(segment.minutes).map((part, index) => (
              <span
                key={index}
                className={part.unit ? styles.durationUnit : `tabular ${styles.durationValue}`}
              >
                {part.text}
              </span>
            ))}
          </span>
        </div>
        <div className={styles.cardMeta}>
          {isWalk ? <WalkMeta segment={segment} /> : <RideMeta segment={segment} />}
        </div>
      </div>
    </>
  );
}

function legLabel(segment: RouteSegment): string {
  if (segment.type === SegmentType.walk) return ja.resultWalkLabel;
  if (segment.line !== null) return segment.line;
  return segment.type === SegmentType.bus
    ? ja.resultBusDefaultLabel
    : ja.resultTrainDefaultLabel;
}

// 徒歩レッグの km/kcal は経路生成が必ず埋めるが、型は null を許す。移植元は `!` で
// 落としていた——描画で落とす価値は無いので、欠けている側だけ出さない。
function WalkMeta({ segment }: { segment: RouteSegment }) {
  return (
    <MetaParts
      parts={[
        segment.km !== null ? (
          <span className="tabular">{`${segment.km.toFixed(1)}km`}</span>
        ) : null,
        segment.kcal !== null ? (
          <span className={styles.kcal}>{resultLegKcal(segment.kcal)}</span>
        ) : null,
      ]}
    />
  );
}

function RideMeta({ segment }: { segment: RouteSegment }) {
  return (
    <MetaParts
      parts={[
        <span>{`${segment.fromName} → ${segment.toName}`}</span>,
        // [RouteSegment.fare] を埋める経路は現状どこにも無く、この分岐は常に不発
        // （docs/spec/route-optimization.md §4 #71）。それでも器ごと消さないのは、別の
        // 運賃ソースを得たときにパーサの配線だけで点灯できるようにするため（同 §4 #71）。
        segment.fare !== null ? (
          <span className="tabular">{`¥${segment.fare}`}</span>
        ) : null,
      ]}
    />
  );
}

/// 欠けた要素を落としたうえで中黒を挟む。出す・出さないの判定側で区切りまで持つと、
/// 片方が欠けたときに中黒だけが残る。
function MetaParts({ parts }: { parts: (React.ReactNode | null)[] }) {
  const present = parts.filter((part) => part !== null);
  return (
    <>
      {present.map((part, index) => (
        <span key={index} className={styles.metaPart}>
          {index > 0 && (
            <span className={styles.metaSeparator} aria-hidden="true">
              ·
            </span>
          )}
          {part}
        </span>
      ))}
    </>
  );
}
