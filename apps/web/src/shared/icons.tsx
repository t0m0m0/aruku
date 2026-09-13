// 移植元: lib/shared/icons/ic.dart。
//
// ただし Dart 側は Canvas 命令で描いており、そこから起こし直してはいない。原本は
// design_handoff_aruku_mvp/design-reference/icons.jsx の SVG で、Dart 版がそれを
// Canvas へ移したもの——戻り先はハンドオフのほう。
//
// 色は currentColor に寄せ、引数から落とした。移植元は Flutter に「継承される文字色」
// が無いため色を必ず渡していたが、CSS では親の color が降りてくる。
//
// すべて aria-hidden。意味はラベル側が持つ（アイコンだけのボタンは _IconHit 相当の
// 呼び出し側が aria-label を付ける）。

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

export function ClockIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
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

export function SettingsIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M19 12a7 7 0 00-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 00-2.3-1.3L14 3h-4l-.4 2.4a7 7 0 00-2.3 1.3l-2.3-.9-2 3.4 2 1.5A7 7 0 005 12a7 7 0 00.1 1.3l-2 1.5 2 3.4 2.3-.9a7 7 0 002.3 1.3L10 21h4l.4-2.4a7 7 0 002.3-1.3l2.3.9 2-3.4-2-1.5A7 7 0 0019 12z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
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
      <circle cx="12" cy="9.5" r="2.5" fill={filled ? 'var(--ivory)' : 'currentColor'} />
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
