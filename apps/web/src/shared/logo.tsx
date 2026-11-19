interface ArukuLogoProps {
  size?: number;
}

export function ArukuLogo({ size = 44 }: ArukuLogoProps) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex flex-none items-center justify-center bg-moss-500 shadow-[0_4px_12px_rgb(54_80_30/0.22)]"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${size / 3}px`,
      }}
    >
      <svg
        width={size * 0.65}
        height={size * 0.65}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-ivory)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 5C9 5 5 11 5 16C6 10 11 7 17 6C16 10 15 13 12 14.5" />
        <circle cx="7" cy="18.5" r="1.4" fill="var(--color-ivory)" stroke="none" />
      </svg>
    </span>
  );
}
