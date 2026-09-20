/// 移植元: lib/core/config/layout_breakpoints.dart。
///
/// プラットフォームではなく幅で切り替える。デスクトップブラウザのウィンドウを
/// 狭めたらモバイル UI が出るのが正しい挙動で、逆に幅の広いタブレットは
/// デスクトップ相当の余白を扱える。#372 参照。

/// デスクトップレイアウトへ切り替えるビューポート幅（CSS ピクセル）。
export const desktopBreakpointPx = 820;

/// 幅の判定に使うメディアクエリ。境界ちょうどはデスクトップ側
/// （移植元の `width >= kDesktopBreakpoint` と同じ向き）。
export const desktopMediaQuery = `(min-width: ${desktopBreakpointPx}px)`;
