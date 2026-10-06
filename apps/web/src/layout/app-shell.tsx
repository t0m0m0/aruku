// 移植元: flutter-final:lib/shared/widgets/desktop_shell.dart。
//
// 移植元はデスクトップ幅でだけ被せていた。#439 で幅に関係なく出すことにした——
// モバイル幅にはアプリ名もロゴも無く、子画面から home へ降りる共通の導線も無かった。
//
// 移植元が「記録」タブとストリークチップを持たないのは（ハンドオフには在る）、
// どちらも歩数に依るため。#386 が Web で歩数まわりを作らないと決めている。
// 移植元にあった「設定」タブも #427 で設定画面ごと撤去し、残った「ルートを計画」
// タブも #432 で撤去した。home へ降りる導線はロゴが引き継いでいる。

import type { StoreApi } from 'zustand/vanilla';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router';

import { ja } from '../i18n/ja';
import { Screen, screenFromLocation } from '../navigation/screens';
import { ArukuLogo } from '../shared/logo';
import type { AppStore } from '../state/store';

interface AppShellProps {
  store: StoreApi<AppStore>;
}

/// 全画面に被せる共通シェル（上部バー + 本文）。
///
/// レイアウトルートとして使う。移植元はこれを Navigator の外側へ置いていたが、
/// それは go_router のネスト構造が戻り先そのものだったため。React Router の
/// ネストは `<Outlet>` の入れ子であって履歴を積まない（戻り先を作るのは
/// navigator.ts）ので、ここで包んでも戻り挙動には触れない。
export function AppShell({ store }: AppShellProps) {
  const pathname = useLocation().pathname;

  // 本文の器は遷移で作り直されない（替わるのは <Outlet> の中身だけ）。この器が
  // スクローラなので、前の画面の scrollTop を次の画面が引き継ぎ、開いた瞬間に
  // 途中から始まって見える。ブラウザの復元は document のスクロールしか見ない
  // （PR #407 の Codex レビュー）。
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [pathname]);

  // 待ち画面からの離脱では探索を明示的に打ち切る。打ち切らないと探索は走り続け、
  // 完了時に startSearch が result / error へ引き戻す。子から home への go は
  // 履歴の back（POP）なので今は watchSearchAbandon も拾うが、それに頼ると
  // home 以外へ移る導線を足したとき（push で出ていく）に黙って穴が開く。
  //
  // 打ち切りに **遷移を伴わせない**（cancelSearch ではなく abandonSearch）。
  // cancelSearch は home への go を含み、待ち画面からのそれは履歴の back
  // ——実ブラウザでは非同期に解決する。続けて別の遷移を投げると、保留中の POP が
  // 後から勝って行き先ではなく home に着く（e2e で再現。PR #407 の Codex レビュー）。
  const goHome = () => {
    const state = store.getState();
    if (screenFromLocation(pathname) === Screen.loading) state.abandonSearch();
    state.go(Screen.home);
  };

  // 移植元: design_handoff_aruku_web/README.md「0. 共通シェル」。
  //
  // 高さは 100vh ではなく 100dvh。携帯やタブレットではブラウザの UI が伸び縮みし、
  // 100vh は大きい側のまま固定される——overflow を切っているこの器では下端が届かなく
  // なる（PR #407 の Codex レビュー）。
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ivory">
      <header className="h-16 flex-none border-b border-hairline bg-paper">
        {/* ハンドオフの 1280px 中央寄せにしない。本文は画面ごとに幅が違うので、
            ロゴだけが広い画面で宙に浮いて見えた。 */}
        <div className="flex h-full items-center gap-5 px-5 desktop:px-6">
          {/* <a href> にしない。遷移は go() を通す——router を直に動かすと、子から
              home への pop が push になって履歴が伸びる（navigator.ts）。 */}
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2.5 rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-moss-700"
            aria-label={ja.shellHome}
            onClick={goHome}
          >
            <ArukuLogo size={34} />
            <span className="text-[19px] font-black tracking-[0.04em] text-ink">
              {ja.appTitle}
            </span>
          </button>
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
