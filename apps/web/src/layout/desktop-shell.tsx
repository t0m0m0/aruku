// 移植元: lib/shared/widgets/desktop_shell.dart。
//
// 移植元が「記録」タブとストリークチップを持たないのは（ハンドオフには在る）、
// どちらも歩数に依るため。#386 が Web で歩数まわりを作らないと決めているので、
// タブは移植元と同じ2つに留める。

import type { StoreApi } from 'zustand/vanilla';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router';

import { ja } from '../i18n/ja';
import { Screen, screenFromLocation } from '../navigation/screens';
import { ArukuLogo } from '../shared/logo';
import { RoutesIcon, SettingsIcon } from '../shared/icons';
import type { AppStore } from '../state/store';
import { useIsDesktop } from './use-is-desktop';
import styles from './desktop-shell.module.css';

interface DesktopShellProps {
  store: StoreApi<AppStore>;
}

/// デスクトップ幅で全画面に被せる共通シェル（上部バー + 本文）。
///
/// レイアウトルートとして使う。移植元はこれを Navigator の外側へ置いていたが、
/// それは go_router のネスト構造が戻り先そのものだったため。React Router の
/// ネストは `<Outlet>` の入れ子であって履歴を積まない（戻り先を作るのは
/// navigator.ts）ので、ここで包んでも戻り挙動には触れない。
export function DesktopShell({ store }: DesktopShellProps) {
  const isDesktop = useIsDesktop();
  const pathname = useLocation().pathname;
  const screen = screenFromLocation(pathname);

  // 本文の器は遷移で作り直されない（替わるのは <Outlet> の中身だけ）。この器が
  // スクローラなので、前の画面の scrollTop を次の画面が引き継ぎ、開いた瞬間に
  // 途中から始まって見える。ブラウザの復元は document のスクロールしか見ない
  // （PR #407 の Codex レビュー）。
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [pathname]);
  if (!isDesktop) return <Outlet />;

  // 設定以外はすべて「ルートを計画」の下にある導線。
  const onSettings = screen === Screen.settings;

  // 待ち画面からの離脱は go だけでは足りない。画面を移しても探索は走り続け、
  // 完了時に startSearch が result / error へ引き戻す。戻る操作なら
  // watchSearchAbandon が拾うが、タブは push で出ていくので掛からない。
  //
  // 打ち切りに **遷移を伴わせない**（cancelSearch ではなく abandonSearch）。
  // cancelSearch は home への go を含み、待ち画面からのそれは履歴の back
  // ——実ブラウザでは非同期に解決する。続けてタブの遷移を投げると、保留中の POP が
  // 後から勝って設定ではなく home に着く（e2e で再現。PR #407 の Codex レビュー）。
  const leave = (target: Screen) => {
    const state = store.getState();
    if (screen === Screen.loading) state.abandonSearch();
    state.go(target);
  };

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <div className={styles.barInner}>
          <ArukuLogo size={34} />
          <span className={styles.wordmark}>{ja.appTitle}</span>
          <nav className={styles.tabs}>
            <Tab
              label={ja.shellTabPlan}
              icon={<RoutesIcon size={16} />}
              selected={!onSettings}
              onPress={() => leave(Screen.home)}
            />
            <Tab
              label={ja.shellTabSettings}
              icon={<SettingsIcon size={16} />}
              selected={onSettings}
              onPress={() => leave(Screen.settings)}
            />
          </nav>
        </div>
      </header>
      <div className={styles.body} ref={body} data-testid="shell-body">
        <Outlet />
      </div>
    </div>
  );
}

interface TabProps {
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  onPress: () => void;
}

/// 移植元は InkWell + Semantics(button:, selected:) で組んでいた。`<button>` を
/// 使えば読み上げも Enter / Space も素で付く——移植元が GestureDetector を避けた
/// 理由（キーボードだけの利用者が主要導線を辿れなくなる）はそのまま効いている。
function Tab({ label, icon, selected, onPress }: TabProps) {
  return (
    <button
      type="button"
      className={styles.tab}
      aria-current={selected ? 'page' : undefined}
      onClick={onPress}
    >
      <span aria-hidden="true" style={{ display: 'inline-flex' }}>
        {icon}
      </span>
      {label}
    </button>
  );
}
