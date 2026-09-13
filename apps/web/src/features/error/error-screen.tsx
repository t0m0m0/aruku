// 移植元: lib/features/error/error_screen.dart
//
// DesktopContent（デスクトップ幅の中央寄せ）は運んでいない。#372 の作り分けと対で、
// 検索スライスで見送ったのと同じ理由（PORTING.md）。

import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { ja } from '../../i18n/ja';
import { Screen } from '../../navigation/screens';
import { ArukuButton } from '../../shared/button';
import { RoutesIcon } from '../../shared/icons';
import { RouteErrorKind } from '../../state/app-state';
import { RouteRecovery, routeErrorView } from '../../state/route-error';
import type { AppStore } from '../../state/store';
import styles from './error-screen.module.css';

interface ErrorScreenProps {
  store: StoreApi<AppStore>;
}

export function ErrorScreen({ store }: ErrorScreenProps) {
  // ガードが通す以上ここへは種別付きでしか来ないが、欠けていても空の画面を見せない。
  const kind = useStore(store, (s) => s.routeErrorKind) ?? RouteErrorKind.unknown;
  const go = useStore(store, (s) => s.go);
  const startSearch = useStore(store, (s) => s.startSearch);

  const view = routeErrorView(kind);

  const retry = {
    label: ja.errorRetry,
    onPress: () => {
      void startSearch();
    },
  };
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
    <main className={styles.screen}>
      <span className={styles.badge} aria-hidden="true">
        <RoutesIcon size={32} />
      </span>
      <h1 className={styles.title}>{view.title}</h1>
      <p className={styles.description}>{view.description}</p>

      <div className={styles.actions}>
        <ArukuButton
          className={styles.action}
          label={primary.label}
          onPress={primary.onPress}
        />
        <ArukuButton
          className={styles.action}
          variant="outlined"
          label={secondary.label}
          onPress={secondary.onPress}
        />
      </div>
    </main>
  );
}
