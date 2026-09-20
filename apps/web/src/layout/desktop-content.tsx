// 移植元: lib/shared/widgets/desktop_content.dart。

import type { ReactNode } from 'react';

import { useIsDesktop } from './use-is-desktop';

interface DesktopContentProps {
  /// 本文の最大幅（CSS ピクセル）。画面ごとに違う（ルート計画 620 / 設定 760 /
  /// エラー 520）ので、クラスではなくインラインで与える——CSS Modules の値は
  /// jsdom から読めず、画面ごとの取り違えをテストで反証できない。
  maxWidth: number;

  children: ReactNode;
}

/// デスクトップ幅でのみ本文を [maxWidth] で頭打ちにし、中央へ寄せる。
///
/// モバイル幅で子を素通しするのは、`< 820px` の見た目を1ピクセルも変えないため。
/// 包む要素が1つ増えるだけでも flex の子や `:first-child` の効き方が変わりうる。
export function DesktopContent({ maxWidth, children }: DesktopContentProps) {
  const isDesktop = useIsDesktop();
  if (!isDesktop) return <>{children}</>;
  return (
    <div style={{ maxWidth: `${maxWidth}px`, marginInline: 'auto', width: '100%' }}>
      {children}
    </div>
  );
}
