// 移植元: flutter-final:lib/shared/widgets/aruku_map.dart の _StylizedMapPainter。
//
// 実地図が出せないときに敷く作り物の地図。移植元では useRealMap が既定で false
// （--dart-define=USE_REAL_MAP=true で初めて実地図になる）なので、これは例外時の絵
// ではなく通常の描画経路。

import { useEffect, useRef, useState } from 'react';


/// 枠を測れるまでの寸法。
///
/// 移植元は実ピクセルの Size を受け取り、図形ごとに「割合で置くもの」（公園・道路・経路）と
/// 「絶対寸法で置くもの」（建物 26x22、ピンの半径、線の太さ）を混ぜている。ここも同じく
/// 枠の実寸を viewBox にして 1 単位 = 1px にする——固定の viewBox を slice で埋めると、
/// 枠の縦横比が違うぶんだけ切り落とされ、縦長の背景では横 360 単位のうち中央 108 単位しか
/// 映らない（公園も建物も画面外、道路だけ 3.3 倍に太る）。かといって縦横比を無視して
/// 伸ばすと、今度は建物とピンが枠なりに潰れる。測るのが両方を満たす唯一の形。
const fallbackSize = { w: 360, h: 240 };

const minorRoads = [1, 2, 3, 4, 5];
const buildings = [0.18, 0.32, 0.58, 0.74, 0.88];

interface StylizedMapProps {
  showRoute?: boolean;
}

export function StylizedMap({ showRoute = true }: StylizedMapProps) {
  const frame = useRef<HTMLDivElement>(null);
  const { w, h } = useFrameSize(frame);

  /// 移植元の Offset(size.width * fx, size.height * fy) に対応する。
  const x = (fx: number) => fx * w;
  const y = (fy: number) => fy * h;

  const start = { x: x(0.12), y: y(0.18) };
  const board = { x: x(0.35), y: y(0.5) };
  const alight = { x: x(0.6), y: y(0.55) };
  const end = { x: x(0.85), y: y(0.85) };

  return (
    // svg は測った実寸で描くので、枠のほうが大きさを決める。
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
          <line
            key={`h-${i}`}
            x1="0"
            y1={y(0.15 * i)}
            x2={w}
            y2={y(0.15 * i + 0.05)}
          />
        ))}
        {minorRoads.map((i) => (
          <line
            key={`v-${i}`}
            x1={x(0.2 * i)}
            y1="0"
            x2={x(0.2 * i - 0.05)}
            y2={h}
          />
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

/// 枠の実寸。ResizeObserver の無い環境（jsdom）では既定の寸法のまま描く。
function useFrameSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState(fallbackSize);

  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver !== 'function') return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
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
