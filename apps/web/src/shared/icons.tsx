// 移植元: flutter-final:lib/shared/icons/ic.dart。
//
// ただし Dart 側は Canvas 命令で描いており、そこから起こし直してはいない。原本は
// design_handoff_aruku_mvp/design-reference/icons.jsx の SVG で、Dart 版がそれを
// Canvas へ移したもの——戻り先はハンドオフのほう。
//
// 色は currentColor に寄せ、引数から落とした。移植元は Flutter に「継承される文字色」
// が無いため色を必ず渡していたが、CSS では親の color が降りてくる。
//
// すべて aria-hidden。意味はラベル側が持つ（アイコンだけのボタンは呼び出し側が
// aria-label を付ける）。

interface IconProps {
  size?: number;
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    focusable: false,
  } as const;
}

export function SearchIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="10.5" cy="10.5" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 15l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WalkIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="14" cy="4.5" r="2" fill="currentColor" />
      <path
        d="M9 21l2.5-5.5L9 12l-2 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.5 15.5l2.5 1.5.8 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 11.5L10 8.5h3.5l2.5 2.5L18 13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TrainIcon({ size = 16 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="5" y="3" width="14" height="14" rx="3.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5 11h14" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="9" cy="14" r="1" fill="currentColor" />
      <circle cx="15" cy="14" r="1" fill="currentColor" />
      <path d="M8 17l-2 4M16 17l2 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function ClockIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/// ハンドオフに無い形。ClockIcon と線幅・角を揃えて起こした。
export function CalendarIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M4 10h16M8.5 3.5v4M15.5 3.5v4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CompassIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="M14.5 9.5L9.5 11l-1 4 5-1.5 1-4z" fill="currentColor" />
    </svg>
  );
}

export function RoutesIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="6" cy="6" r="2" fill="currentColor" />
      <circle cx="18" cy="18" r="2" fill="currentColor" />
      <path
        d="M6 8c0 6 6 4 6 10M12 18h6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/// 目的地マーカー。塗りつぶすと内側の丸は地の色で抜く（移植元と同じ）。
export function PinIcon({ size = 20, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <svg {...svgProps(size)}>
      <path
        d="M12 21s-7-6.5-7-12a7 7 0 0114 0c0 5.5-7 12-7 12z"
        stroke="currentColor"
        strokeWidth="1.7"
        fill={filled ? 'currentColor' : 'none'}
        strokeLinejoin="round"
      />
      <circle cx="12" cy="9.5" r="2.5" fill={filled ? 'var(--color-ivory)' : 'currentColor'} />
    </svg>
  );
}

export type ChevronDir = 'left' | 'right' | 'up' | 'down';

const chevronRotation: Readonly<Record<ChevronDir, number>> = {
  right: 0,
  left: 180,
  up: -90,
  down: 90,
};

export function ChevronIcon({ size = 18, dir = 'right' }: IconProps & { dir?: ChevronDir }) {
  return (
    <svg {...svgProps(size)} style={{ transform: `rotate(${chevronRotation[dir]}deg)` }}>
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
