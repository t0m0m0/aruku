// 移植元: flutter-final:lib/shared/widgets/desktop_shell.dart。
//
// 移植元が「記録」タブとストリークチップを持たないのは（ハンドオフには在る）、
// どちらも歩数に依るため。#386 が Web で歩数まわりを作らないと決めている。
// 移植元にあった「設定」タブも #427 で設定画面ごと撤去し、残った「ルートを計画」
// タブも #432 で撤去した。home へ降りる出口は各画面が自前で持っている
// （待ち画面のキャンセル・結果画面の戻る・エラー画面の「検索に戻る」）。

import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router';

import { ja } from '../i18n/ja';
import { ArukuLogo } from '../shared/logo';
import { useIsDesktop } from './use-is-desktop';

/// デスクトップ幅で全画面に被せる共通シェル（上部バー + 本文）。
///
/// レイアウトルートとして使う。移植元はこれを Navigator の外側へ置いていたが、
/// それは go_router のネスト構造が戻り先そのものだったため。React Router の
/// ネストは `<Outlet>` の入れ子であって履歴を積まない（戻り先を作るのは
/// navigator.ts）ので、ここで包んでも戻り挙動には触れない。
export function DesktopShell() {
  const isDesktop = useIsDesktop();
  const pathname = useLocation().pathname;

  // 本文の器は遷移で作り直されない（替わるのは <Outlet> の中身だけ）。この器が
  // スクローラなので、前の画面の scrollTop を次の画面が引き継ぎ、開いた瞬間に
  // 途中から始まって見える。ブラウザの復元は document のスクロールしか見ない
  // （PR #407 の Codex レビュー）。
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [pathname]);
  if (!isDesktop) return <Outlet />;

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
