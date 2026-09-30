// 移植元: flutter-final:lib/features/result/result_timeline.dart。
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
import { cn } from '../../shared/utils';

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
    <ol>
      {steps.map(({ node, segment, connector }, index) => (
        // 移植元は各行が [44px 時刻][14 隙間][16 トラック][残り] の Row だった。行ごとに
        // 同じ幅指定を書くと、片方だけ直したときにトラックの縦線が折れる。1 つのグリッドに
        // 乗せて列を共有する——ノード行とレッグ行が同じ li の中にあるのはそのため。
        <li key={index} className="grid grid-cols-[44px_16px_1fr] items-start gap-x-3.5">
          <span className="tabular col-start-1 pt-px text-right text-[11px] font-bold text-ink-3">
            {node.time}
          </span>
          <span className="relative col-start-2 h-full min-h-3" aria-hidden="true">
            <span className="absolute top-1 left-1.5 size-1 rounded-full bg-ink-2" />
          </span>
          <span className="col-start-3 flex min-w-0 flex-col gap-px pb-1">
            <span className="text-[13px] font-bold text-ink">{node.place}</span>
            {node.sub !== '' && (
              <span className="text-[11px] font-medium text-ink-3">{node.sub}</span>
            )}
          </span>
          {segment !== null && <Leg segment={segment} />}
          {/* 直結乗換の「着」行と「発」行のあいだ。カードが入らないぶん縦線が切れるので、
              短い実線で繋ぐ。 */}
          {connector && (
            <span className="col-start-2 ml-[6.5px] h-3 border-l-3 border-train" aria-hidden="true" />
          )}
        </li>
      ))}
    </ol>
  );
}

/// 区間の種別ごとの色の組。トラック・カード・アイコンと所要時間の色は、どれも
/// 徒歩か乗り物かの一点で決まる。
///
/// 徒歩は破線、乗り物は実線（移植元の _SegLinePainter の dashed がこの差だった）。
/// バス専用のアイコン・色は未デザインのため、当面は電車と同じ見た目を流用する（#249）。
const legTones = {
  walk: {
    track: 'border-dotted border-moss-600',
    card: 'border-moss-100 bg-moss-50',
    accent: 'text-moss-600',
  },
  ride: {
    track: 'border-train',
    card: 'border-train/18 bg-train/8',
    accent: 'text-train',
  },
} as const;

function Leg({ segment }: { segment: RouteSegment }) {
  const isWalk = segment.type === SegmentType.walk;
  const tone = isWalk ? legTones.walk : legTones.ride;
  return (
    <>
      <span
        className={cn('col-start-2 my-1.5 ml-[6.5px] self-stretch border-l-3', tone.track)}
        aria-hidden="true"
      />
      <div className={cn('col-start-3 my-1.5 rounded-sm border px-3 py-2', tone.card)}>
        <div className="flex items-center gap-2">
          <span className={cn('flex flex-none', tone.accent)} aria-hidden="true">
            {isWalk ? <WalkIcon size={16} /> : <TrainIcon size={16} />}
          </span>
          <span className="min-w-0 flex-1 text-[13px] font-bold text-ink">{legLabel(segment)}</span>
          <span className={cn('flex flex-none items-baseline', tone.accent)}>
            {resultSegmentDuration(segment.minutes).map((part, index) => (
              <span
                key={index}
                className={
                  part.unit ? 'text-[10px] font-bold' : 'tabular text-[12px] font-extrabold'
                }
              >
                {part.text}
              </span>
            ))}
          </span>
        </div>
        <div className="mt-1 flex items-center text-[11px] font-semibold text-ink-2">
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
          <span className="font-extrabold text-burnt">{resultLegKcal(segment.kcal)}</span>
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
        <span key={index} className="inline-flex items-center">
          {index > 0 && (
            <span className="mx-2 text-ink-4" aria-hidden="true">
              ·
            </span>
          )}
          {part}
        </span>
      ))}
    </>
  );
}
