import { useEffect, useRef, useState } from 'react';

const fallbackSize = { w: 360, h: 240 };

const minorRoads = [1, 2, 3, 4, 5];
const buildings = [0.18, 0.32, 0.58, 0.74, 0.88];

interface StylizedMapProps {
  showRoute?: boolean;
}

export function StylizedMap({ showRoute = true }: StylizedMapProps) {
  const frame = useRef<HTMLDivElement>(null);
  const { w, h } = useFrameSize(frame);

  const x = (fx: number) => fx * w;
  const y = (fy: number) => fy * h;

  const start = { x: x(0.12), y: y(0.18) };
  const board = { x: x(0.35), y: y(0.5) };
  const alight = { x: x(0.6), y: y(0.55) };
  const end = { x: x(0.85), y: y(0.85) };

  return (
    <div ref={frame} className="size-full">
      <svg
        className="block size-full"
        viewBox={`0 0 ${w} ${h}`}
        aria-hidden={true}
        focusable={false}
      >
        <rect className="fill-map-bg" x="0" y="0" width={w} height={h} />

        <ellipse
          className="fill-map-park"
          cx={x(0.2)}
          cy={y(0.3)}
          rx={x(0.55) / 2}
          ry={y(0.32) / 2}
        />
        <ellipse
          className="fill-map-park"
          cx={x(0.78)}
          cy={y(0.72)}
          rx={x(0.5) / 2}
          ry={y(0.3) / 2}
        />

        <rect className="fill-map-water" x="0" y={y(0.82)} width={w} height={y(0.18)} />

        <g className="stroke-map-major stroke-10">
          <line x1="0" y1={y(0.45)} x2={w} y2={y(0.55)} />
          <line x1={x(0.6)} y1="0" x2={x(0.5)} y2={h} />
        </g>

        <g className="stroke-map-road stroke-5">
          {minorRoads.map((i) => (
            <line key={`h-${i}`} x1="0" y1={y(0.15 * i)} x2={w} y2={y(0.15 * i + 0.05)} />
          ))}
          {minorRoads.map((i) => (
            <line key={`v-${i}`} x1={x(0.2 * i)} y1="0" x2={x(0.2 * i - 0.05)} y2={h} />
          ))}
        </g>

        {buildings.map((r) => (
          <rect
            key={r}
            className="fill-map-build"
            x={x(r) - 13}
            y={y(0.2 + r * 0.5) - 11}
            width="26"
            height="22"
            rx="3"
          />
        ))}

        {showRoute ? <StylizedRoute start={start} board={board} alight={alight} end={end} /> : null}
      </svg>
    </div>
  );
}

function useFrameSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState(fallbackSize);

  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver !== 'function') return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(0)?.contentRect;
      if (rect === undefined || rect.width <= 0 || rect.height <= 0) return;
      setSize({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return size;
}

interface Point {
  x: number;
  y: number;
}

function StylizedRoute({
  start,
  board,
  alight,
  end,
}: {
  start: Point;
  board: Point;
  alight: Point;
  end: Point;
}) {
  return (
    <g data-part="route">
      <line
        className="stroke-train stroke-6 [stroke-linecap:round]"
        x1={board.x}
        y1={board.y}
        x2={alight.x}
        y2={alight.y}
      />
      <line
        className="stroke-walk stroke-5 [stroke-dasharray:6_4] [stroke-linecap:round]"
        x1={start.x}
        y1={start.y}
        x2={board.x}
        y2={board.y}
      />
      <line
        className="stroke-walk stroke-5 [stroke-dasharray:6_4] [stroke-linecap:round]"
        x1={alight.x}
        y1={alight.y}
        x2={end.x}
        y2={end.y}
      />

      <circle className="fill-white" cx={start.x} cy={start.y} r="11" />
      <circle className="fill-walk" cx={start.x} cy={start.y} r="7" />
      <circle className="fill-white" cx={start.x} cy={start.y} r="3" />

      <path
        className="fill-burnt stroke-white stroke-2"
        d={
          `M ${end.x} ${end.y + 8}` +
          ` C ${end.x - 9} ${end.y - 4} ${end.x - 9} ${end.y - 8} ${end.x} ${end.y - 12}` +
          ` C ${end.x + 9} ${end.y - 8} ${end.x + 9} ${end.y - 4} ${end.x} ${end.y + 8}` +
          ' Z'
        }
      />
    </g>
  );
}
