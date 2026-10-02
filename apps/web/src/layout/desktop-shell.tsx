// 移植元: flutter-final:lib/shared/widgets/desktop_shell.dart。
//
// 移植元が「記録」タブとストリークチップを持たないのは（ハンドオフには在る）、
// どちらも歩数に依るため。#386 が Web で歩数まわりを作らないと決めている。
// 移植元にあった「設定」タブは、#427 で設定画面ごと撤去した。タブが1つでも
// 「ルートを計画」を残すのは、待ち画面・結果・エラーから home へ戻る出口だから。

import type { StoreApi } from 'zustand/vanilla';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router';

import { ja } from '../i18n/ja';
import { Screen, screenFromLocation } from '../navigation/screens';
import { ArukuLogo } from '../shared/logo';
import { RoutesIcon } from '../shared/icons';
import { Button } from '../shared/ui/button';
import type { AppStore } from '../state/store';
import { useIsDesktop } from './use-is-desktop';

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

  // 待ち画面からの離脱は go だけでは足りない。画面を移しても探索は走り続け、
  // 完了時に startSearch が result / error へ引き戻す。戻る操作なら
  // watchSearchAbandon が拾うが、タブは push で出ていくので掛からない。
  //
  // 打ち切りに **遷移を伴わせない**（cancelSearch ではなく abandonSearch）。
  // cancelSearch は home への go を含み、待ち画面からのそれは履歴の back
  // ——実ブラウザでは非同期に解決する。続けてタブの遷移を投げると遷移が二重に走る
  // （設定タブがあった頃に e2e で再現：保留中の POP が後から勝ち、設定ではなく
  // home に着いた。PR #407 の Codex レビュー）。
  const planRoute = () => {
    const state = store.getState();
    if (screen === Screen.loading) state.abandonSearch();
    state.go(Screen.home);
  };

  // 移植元: design_handoff_aruku_web/README.md「0. 共通シェル」。
  //
  // 高さは 100vh ではなく 100dvh。820px を跨ぐ幅の端末（大きめのタブレット・横向きの
  // 携帯）ではブラウザの UI が伸び縮みし、100vh は大きい側のまま固定される——overflow を
  // 切っているこの器では下端が届かなくなる（PR #407 の Codex レビュー）。
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ivory">
      <header className="h-16 flex-none border-b border-hairline bg-paper">
        <div className="mx-auto flex h-full max-w-[1280px] items-center gap-5 px-6">
          <ArukuLogo size={34} />
          <span className="-ms-2.5 text-[19px] font-black tracking-[0.04em] text-ink">
            {ja.appTitle}
          </span>
          <nav className="flex items-center gap-1">
            <Tab
              label={ja.shellTabPlan}
              icon={<RoutesIcon size={16} />}
              selected
              onPress={planRoute}
            />
          </nav>
        </div>
      </header>
      {/* 本文側がスクロールする。シェルごとスクロールさせると上部バーが流れる
          （ハンドオフは「固定・スクロールしない」）。min-h-0 が無いと flex の子が
          内容の高さまで伸び、内部スクロールが効かない。

          --screen-min-height は画面の「1画面ぶん」をバーの下の領域に読み替える
          （theme/base.css の既定は 100dvh）。差し替えないと、どの画面もバーの
          高さぶん縦にはみ出す。 */}
      <div
        className="min-h-0 flex-1 overflow-y-auto [--screen-min-height:100%]"
        ref={body}
        data-testid="shell-body"
      >
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
///
/// shadcn の Tabs は使わない。あれは tablist / tabpanel の組で同じページ内の切り替えを
/// 表す。これは画面を移る導線で、現在地は aria-current で表す。
///
/// 選択中の見た目も aria-current から引く。クラスを別に足すと、見た目と読み上げが
/// 別々の条件で付くようになり、片方だけ落ちても気付けない。
function Tab({ label, icon, selected, onPress }: TabProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="aria-[current=page]:bg-moss-100 aria-[current=page]:text-moss-700"
      aria-current={selected ? 'page' : undefined}
      onClick={onPress}
    >
      {icon}
      {label}
    </Button>
  );
}
