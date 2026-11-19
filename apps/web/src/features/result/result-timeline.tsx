import {
  SegmentType,
  type RoutePlan,
  type RouteSegment,
  type TimelineNode,
} from '@aruku/engine/models/route-plan';

import { ja, resultLegOpenInMapsLabel, resultSegmentDuration } from '../../i18n/ja';
import { TrainIcon, WalkIcon } from '../../shared/icons';
import { cn } from '../../shared/utils';
import { buildLegMapsUrl } from './leg-maps-url';

interface ResultTimelineProps {
  route: RoutePlan;
}

export function ResultTimeline({ route }: ResultTimelineProps) {
  const segments = route.segments;
  const steps: {
    node: TimelineNode;
    segment: RouteSegment | null;
    mapsUrl: string | null;
    connector: boolean;
  }[] = [];

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
  return segment.type === SegmentType.bus ? ja.resultBusDefaultLabel : ja.resultTrainDefaultLabel;
}

function WalkMeta({ segment }: { segment: RouteSegment }) {
  return (
    <MetaParts
      parts={[
        segment.km !== null ? (
          <span key="km" className="tabular">{`${segment.km.toFixed(1)}km`}</span>
        ) : null,
      ]}
    />
  );
}

function RideMeta({ segment }: { segment: RouteSegment }) {
  return (
    <MetaParts
      parts={[
        <span key="stations">{`${segment.fromName} → ${segment.toName}`}</span>,
        segment.fare !== null ? (
          <span key="fare" className="tabular">{`¥${segment.fare}`}</span>
        ) : null,
      ]}
    />
  );
}

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
