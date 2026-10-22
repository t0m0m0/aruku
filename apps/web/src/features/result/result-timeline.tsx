// 移植元: flutter-final:lib/features/result/result_timeline.dart。
//
// journey 進捗（#305 の _LegState と _LegStateBadge）は運んでいない。JourneyProgress は
// 歩数同期に依存し、#386 が Web で作らないと決めた側——移植元で言えば journey==null の
// _LegState.none だけが残る。Google マップへの引き継ぎ（移植元 result_leg_cta.dart）は
// 進捗から切り離し、全区間に置いている（#449）。
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

import {
  ja,
  resultLegOpenInMapsLabel,
  resultSegmentDuration,
} from '../../i18n/ja';
import { TrainIcon, WalkIcon } from '../../shared/icons';
import { cn } from '../../shared/utils';
import { buildLegMapsUrl } from './leg-maps-url';

interface ResultTimelineProps {
  route: RoutePlan;
}

/// ノードと区間を交互に積む。両者の 1:1 対応は route-plan-builder が組み立てる
/// （「segments と timelineNodes の 1:1 対応を保つ」）ので、ここでは崩さないことだけを見る。
export function ResultTimeline({ route }: ResultTimelineProps) {
  const segments = route.segments;
  const steps: {
    node: TimelineNode;
    segment: RouteSegment | null;
    mapsUrl: string | null;
    connector: boolean;
  }[] = [];

  // cardBelow:false の駅行（直結乗換の「着」行）は区間を挟まず、次の「発」行へ短い
  // コネクタで繋ぐ。それ以外の行は順に区間を 1 つ消費する。ノードは常に区間より
  // 多い（末尾の到着ノードが余る）ので、使い切ったあとは置かない。
  let cursor = 0;
  route.timelineNodes.forEach((node, index) => {
    const isLast = index === route.timelineNodes.length - 1;
    if (node.cardBelow && cursor < segments.length) {
      steps.push({
        node,
        segment: segments[cursor],
        mapsUrl: buildLegMapsUrl(route, cursor),
        connector: false,
      });
      cursor += 1;
    } else {
      steps.push({ node, segment: null, mapsUrl: null, connector: !node.cardBelow && !isLast });
    }
  });

  return (
    <ol>
      {steps.map(({ node, segment, mapsUrl, connector }, index) => (
        // 移植元は各行が [44px 時刻][14 隙間][16 トラック][残り] の Row だった。行ごとに
        // 同じ幅指定を書くと、片方だけ直したときにトラックの縦線が折れる。1 つのグリッドに
        // 乗せて列を共有する——ノード行とレッグ行が同じ li の中にあるのはそのため。
        <li key={index} className="grid grid-cols-[52px_24px_1fr] items-start gap-x-3">
          <span className="tabular col-start-1 pt-0.5 text-title-medium">{node.time}</span>
          <span className="col-start-2 flex justify-center" aria-hidden="true">
            <NodeMarker
              kind={
                index === steps.length - 1
                  ? 'end'
                  : segment?.type === SegmentType.walk
                    ? 'walk'
                    : 'ride'
              }
            />
          </span>
          <span className="col-start-3 flex min-w-0 flex-col">
            <span className="text-title-large">{node.place}</span>
            {node.sub !== '' && (
              <span className="text-body-medium text-on-surface-variant">{node.sub}</span>
            )}
          </span>
          {segment !== null && <Leg segment={segment} mapsUrl={mapsUrl} />}
          {/* 直結乗換の「着」行と「発」行のあいだ。区間が入らないぶん縦線が切れるので、
              短い実線で繋ぐ。 */}
          {connector && (
            <span
              className="col-start-2 h-3 w-1.5 justify-self-center bg-ride"
              aria-hidden="true"
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/// 地点の目印。始点・途中は次の区間の色の輪、終点だけは塗りつぶして到着を示す。
function NodeMarker({ kind }: { kind: 'walk' | 'ride' | 'end' }) {
  if (kind === 'end') {
    return (
      <span className="mt-1 size-5 rounded-full border-4 border-primary-container bg-primary" />
    );
  }
  return (
    <span
      className={cn(
        'mt-[7px] size-3.5 rounded-full border-3 bg-surface',
        kind === 'walk' ? 'border-primary' : 'border-ride',
      )}
    />
  );
}

/// 区間の種別ごとの色の組。トラック・アイコンと所要時間の色は、どれも徒歩か乗り物かの
/// 一点で決まる。徒歩は M3 の primary、乗り物は拡張色の ride。
///
/// 徒歩は点線、乗り物は実線（移植元の _SegLinePainter の dashed がこの差だった）。点線を
/// border-dotted で描かないのは、6px 幅の枠線の点が四角く潰れて丸に見えないため。
/// バス専用のアイコン・色は未デザインのため、当面は電車と同じ見た目を流用する（#249）。
const legTones = {
  walk: {
    track:
      'bg-[radial-gradient(circle,var(--color-primary)_3px,transparent_3.5px)] bg-size-[6px_12px] bg-repeat-y',
    accent: 'text-primary',
  },
  ride: {
    track: 'rounded-full bg-ride',
    accent: 'text-ride',
  },
} as const;

// 塗りのカードで区間を囲まない。区切りはトラックと文字の段階が受け持ち、面を重ねると
// M3 の「面の濃淡で階層を作る」とぶつかる（どの面より上か、が区間ごとに生まれる）。
function Leg({ segment, mapsUrl }: { segment: RouteSegment; mapsUrl: string | null }) {
  const isWalk = segment.type === SegmentType.walk;
  const tone = isWalk ? legTones.walk : legTones.ride;
  return (
    <>
      <span
        className={cn('col-start-2 my-1 w-1.5 justify-self-center self-stretch', tone.track)}
        aria-hidden="true"
      />
      <div className="col-start-3 flex min-w-0 flex-col items-start py-3">
        <div className="flex items-center gap-2 text-body-large">
          <span className={cn('flex flex-none', tone.accent)} aria-hidden="true">
            {isWalk ? <WalkIcon size={20} /> : <TrainIcon size={20} />}
          </span>
          <span className="min-w-0">{legLabel(segment)}</span>
          <span className={cn('flex flex-none items-baseline', tone.accent)}>
            {resultSegmentDuration(segment.minutes).map((part, index) => (
              <span
                key={index}
                className={part.unit ? 'text-label-medium' : 'tabular text-title-medium'}
              >
                {part.text}
              </span>
            ))}
          </span>
        </div>
        <div className="flex items-center text-body-medium text-on-surface-variant">
          {isWalk ? <WalkMeta segment={segment} /> : <RideMeta segment={segment} />}
        </div>
        {mapsUrl !== null && (
          // M3 のテキストボタン。左の余白ぶん -ml-3 で引き、文字を区間名の左端に揃える。
          // rel は target=_blank の暗黙の noopener に任せない（home-screen.tsx の LegalLink と同じ）。
          <a
            className="-ml-3 inline-flex min-h-tap-min items-center rounded-full px-3 text-label-large text-primary hover:bg-primary/8 focus-visible:outline-2 focus-visible:outline-primary"
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={resultLegOpenInMapsLabel(legLabel(segment), segment.toName)}
          >
            {ja.resultLegOpenInMaps}
          </a>
        )}
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

// 徒歩レッグの km は経路生成が必ず埋めるが、型は null を許す。移植元は `!` で
// 落としていた——描画で落とす価値は無いので、欠けていれば出さない。
//
// 区間の kcal は埋まっていても出さない。経路全体の値を結果画面の補助情報に1回だけ
// 出しており、区間にも並べると同じ事実が2か所になる（#453）。
function WalkMeta({ segment }: { segment: RouteSegment }) {
  return (
    <MetaParts
      parts={[
        segment.km !== null ? (
          <span className="tabular">{`${segment.km.toFixed(1)}km`}</span>
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
            <span className="mx-2 text-outline" aria-hidden="true">
              ·
            </span>
          )}
          {part}
        </span>
      ))}
    </>
  );
}
