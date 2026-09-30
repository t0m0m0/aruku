// 移植元: flutter-final:lib/features/error/error_screen.dart
//
// 移植元の DesktopContent に当たる中央寄せは、器のウィジェットではなく最上位要素の
// `desktop:` ユーティリティで持つ。

import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { ja } from '../../i18n/ja';
import { Screen } from '../../navigation/screens';
import { Button } from '../../shared/ui/button';
import { RoutesIcon } from '../../shared/icons';
import { RouteErrorKind } from '../../state/app-state';
import { RouteRecovery, routeErrorView } from '../../state/route-error';
import type { AppStore } from '../../state/store';

interface ErrorScreenProps {
  store: StoreApi<AppStore>;
}

export function ErrorScreen({ store }: ErrorScreenProps) {
  // ガードが通す以上ここへは種別付きでしか来ないが、欠けていても空の画面を見せない。
  const kind = useStore(store, (s) => s.routeErrorKind) ?? RouteErrorKind.unknown;
  const go = useStore(store, (s) => s.go);
  const startSearch = useStore(store, (s) => s.startSearch);
  const refreshLocation = useStore(store, (s) => s.refreshLocation);

  const view = routeErrorView(kind);

  // 測位の待ちを跨いで離脱したときの続きを止める。移植元の `if (!mounted) return;`
  // に相当する（検索画面で同じ穴を塞いだのと同じ型）。止めないと、home や検索へ
  // 移った後に検索が始まり、待ち画面へ引きずられる。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const retry = {
    label: ja.errorRetry,
    onPress: () => {
      void retrySearch();
    },
  };

  /// 現在地が取れずに失敗したときだけ、取り直してから引き直す。
  ///
  /// 取り直さないと、権限を許可し直しても一時的な測位失敗が解消しても、同じ null の
  /// 出発地を送り続けて同じ画面へ戻る——主導線が永久に無意味になる。初回取得
  /// （useInitialLocation）は locationState が 'loading' のときしか走らないので、
  /// denied / unavailable で止まった状態は誰も動かさない。
  ///
  /// 無関係な失敗では取り直さない。権限ダイアログを出す理由が無い。
  async function retrySearch(): Promise<void> {
    if (kind === RouteErrorKind.noLocation) await refreshLocation();
    if (!alive.current) return;
    await startSearch();
  }
  const changeConditions = {
    label: ja.resultChangeConditions,
    onPress: () => {
      go(Screen.home);
    },
  };
  const backToSearch = {
    label: ja.resultBackToSearch,
    onPress: () => {
      go(Screen.search);
    },
  };

  // 再試行で直らない種別（候補なし・目的地なし）は、同じ条件で引き直させない。
  const [primary, secondary] =
    view.primaryRecovery === RouteRecovery.changeConditions
      ? [changeConditions, retry]
      : [retry, backToSearch];

  return (
    <main className="flex min-h-(--screen-min-height) flex-col items-center justify-center gap-2.5 px-8 py-6 text-center desktop:mx-auto desktop:max-w-[520px]">
      <span
        className="mb-3.5 grid size-[84px] place-items-center rounded-full border border-hairline bg-paper text-ink-3"
        aria-hidden="true"
      >
        <RoutesIcon size={32} />
      </span>
      <h1 className="text-[20px] font-bold text-ink">{view.title}</h1>
      <p className="text-[14px] font-medium text-ink-3">{view.description}</p>

      <div className="mt-[22px] flex w-full max-w-80 flex-col gap-2.5">
        <Button onClick={primary.onPress}>
          {primary.label}
        </Button>
        <Button variant="outline" onClick={secondary.onPress}>
          {secondary.label}
        </Button>
      </div>
    </main>
  );
}
