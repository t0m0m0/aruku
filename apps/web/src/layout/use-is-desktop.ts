import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { desktopMediaQuery } from './breakpoints';

/// ビューポートがデスクトップ幅かを返す。幅が境界を跨ぐと再描画される。
///
/// 移植元（lib/shared/widgets/responsive_scope.dart）は実測幅を Riverpod の
/// provider へ流し込む注入点を作り、各画面が MediaQuery を直読みしないよう
/// にしていた。web ではこのフックがその1点——画面が window.innerWidth を
/// 直読みすると、幅の両側を作るテストがそのたびにリサイズの模倣になる。
export function useIsDesktop(): boolean {
  // MediaQueryList をモジュールスコープで1つ作らないのは、import した時点の
  // matchMedia を掴んでしまい、テストが差し替える前に確定するため。
  const media = useMemo(() => window.matchMedia(desktopMediaQuery), []);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      media.addEventListener('change', onStoreChange);
      return () => media.removeEventListener('change', onStoreChange);
    },
    [media],
  );

  // useState + useEffect で持たないのは、初回描画が必ずモバイル側になり、
  // デスクトップ幅では1フレームだけモバイル UI が出てから入れ替わるため。
  // useSyncExternalStore は描画そのものの中で現在値を読む。
  return useSyncExternalStore(subscribe, () => media.matches);
}
