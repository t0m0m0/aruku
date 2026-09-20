// 移植元: lib/shared/widgets/logo.dart（CustomPainter の Path をそのまま SVG へ）。

interface ArukuLogoProps {
  /// 一辺の長さ（CSS ピクセル）。角丸は移植元と同じく size/3。
  size?: number;
}

export function ArukuLogo({ size = 44 }: ArukuLogoProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${size / 3}px`,
        background: 'var(--moss-500)',
        boxShadow: '0 4px 12px rgb(54 80 30 / 0.22)',
      }}
    >
      <svg
        width={size * 0.65}
        height={size * 0.65}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--ivory)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 5C9 5 5 11 5 16C6 10 11 7 17 6C16 10 15 13 12 14.5" />
        <circle cx="7" cy="18.5" r="1.4" fill="var(--ivory)" stroke="none" />
      </svg>
    </span>
  );
}
