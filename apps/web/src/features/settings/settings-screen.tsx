// 移植元: lib/features/settings/settings_screen.dart と settings_widgets.dart。
//
// 移植元の5セクションのうち、Web に載るのは権限（注記のみ）と法的情報だけ。通知・
// 週間目標・ヘルスケア連携は #386 が「Web で落ちる機能の UI を作らない」と決めた側で、
// 非対応の理由を出す注記ごと落としている。
//
// その帰結として、この画面には**永続化する設定が1つも無い**。AppSettings・
// SettingsRepository・lost update を防ぐ書き込みの直列化（_queue）・保存失敗の
// SnackBar は、移植元の複雑さの中心でありながらまるごと移植対象から外れる。
//
// 外部リンクは素の <a>。移植元の url_launcher と「リンクを開けませんでした」の
// 通知は運ばない——ブラウザではリンクを開くことが失敗し得る操作ではなく、launcher が
// false を返すという概念自体が無い。

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { privacyPolicyUrl, termsOfServiceUrl } from '../../config';
import { ja } from '../../i18n/ja';
import { Screen } from '../../navigation/screens';
import { ChevronIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import styles from './settings-screen.module.css';

interface SettingsScreenProps {
  store: StoreApi<AppStore>;
}

export function SettingsScreen({ store }: SettingsScreenProps) {
  const go = useStore(store, (s) => s.go);

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          aria-label={ja.commonBack}
          onClick={() => {
            go(Screen.home);
          }}
        >
          <ChevronIcon size={20} dir="left" />
        </button>
        <h1 className={styles.title}>{ja.settingsTitle}</h1>
      </header>

      <SettingsSection title={ja.settingsPermissionsSection}>
        {/* 移植元はここに「端末設定を開く」行があった。Web には開く先が無いので
            リンクごと落とし、権限をどこで変えるのかだけを残す。押しても無反応な
            導線を残すと、権限を変えられない理由が画面から復元できない。 */}
        <p className={styles.note}>{ja.settingsPermissionsNote}</p>
      </SettingsSection>

      <SettingsSection title={ja.settingsLegalSection}>
        <LegalLink label={ja.settingsTermsOfService} href={termsOfServiceUrl} />
        <LegalLink label={ja.settingsPrivacyPolicy} href={privacyPolicyUrl} />
      </SettingsSection>
    </main>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <div className={`card ${styles.sectionCard}`}>{children}</div>
    </section>
  );
}

function LegalLink({ label, href }: { label: string; href: string }) {
  return (
    // rel は target=_blank の暗黙の noopener に任せない。明示しない <a> は、開いた先から
    // window.opener 越しにこちらを操作できる実装が残っている。
    <a
      className={styles.link}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className={styles.linkLabel}>{label}</span>
      <ChevronIcon size={16} dir="right" />
    </a>
  );
}
