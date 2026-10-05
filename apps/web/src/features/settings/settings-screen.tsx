// 移植元: flutter-final:lib/features/settings/settings_screen.dart と settings_widgets.dart。
//
// 移植元の5セクションのうち、Web に載るのは権限（注記のみ）と法的情報だけ。通知・
// 週間目標・ヘルスケア連携は #386 が「Web で落ちる機能の UI を作らない」と決めた側で、
// 非対応の理由を出す注記ごと落としている。
//
// その帰結として、この画面には**永続化する設定が1つも無い**。設定モデル・
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

interface SettingsScreenProps {
  store: StoreApi<AppStore>;
}

export function SettingsScreen({ store }: SettingsScreenProps) {
  const go = useStore(store, (s) => s.go);

  return (
    <main className="flex min-h-(--screen-min-height) flex-col gap-4 px-5 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] desktop:mx-auto desktop:max-w-[760px]">
      {/* 見出しの文字位置を本文の左端へ揃える。戻るボタンは領域だけ左へはみ出す。 */}
      <header className="-ml-1.5 flex items-center gap-1 pt-1">
        <button
          type="button"
          className="grid size-tap-min flex-none cursor-pointer place-items-center rounded-sm text-ink"
          aria-label={ja.commonBack}
          onClick={() => {
            go(Screen.home);
          }}
        >
          <ChevronIcon size={20} dir="left" />
        </button>
        <h1 className="text-[20px] font-extrabold text-ink">{ja.settingsTitle}</h1>
      </header>

      <SettingsSection title={ja.settingsPermissionsSection}>
        {/* 移植元はここに「端末設定を開く」行があった。Web には開く先が無いので
            リンクごと落とし、権限をどこで変えるのかだけを残す。押しても無反応な
            導線を残すと、権限を変えられない理由が画面から復元できない。 */}
        <p className="py-2.5 text-[12px] font-medium text-ink-3">{ja.settingsPermissionsNote}</p>
      </SettingsSection>

      <SettingsSection title={ja.settingsLegalSection}>
        <LegalLink label={ja.legalTermsOfService} href={termsOfServiceUrl} />
        <LegalLink label={ja.legalPrivacyPolicy} href={privacyPolicyUrl} />
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
    // 移植元の _SettingsSection はデスクトップで Row になり、ラベルを幅 200px の左列へ
    // 出す（settings_widgets.dart）。器のウィジェットは要らない——同じ要素の並べ方を
    // 幅で差し替えれば足りる。
    <section className="flex flex-col gap-2 desktop:grid desktop:grid-cols-[200px_1fr] desktop:items-start desktop:gap-0">
      {/* デスクトップ幅ではカードの内側 padding と行の文字位置を揃える
          （移植元の EdgeInsets(4,14,16,0)）。 */}
      <h2 className="ml-1 text-[12px] font-bold text-ink-3 desktop:m-0 desktop:pt-3.5 desktop:pr-4 desktop:pl-1">
        {title}
      </h2>
      {/* 区切り線は行と行のあいだにだけ引く。 */}
      <div className="divide-y divide-hairline rounded-md border border-border bg-card px-4 py-1">
        {children}
      </div>
    </section>
  );
}

function LegalLink({ label, href }: { label: string; href: string }) {
  return (
    // rel は target=_blank の暗黙の noopener に任せない。明示しない <a> は、開いた先から
    // window.opener 越しにこちらを操作できる実装が残っている。
    <a
      // 行の高さを HIG の最小タップ寸法に届かせる。移植元の _LinkRow は上下 14px の
      // padding で同じ高さを作っていた。
      className="flex min-h-tap-min items-center gap-1 py-3.5 text-ink no-underline [&>svg]:flex-none [&>svg]:text-ink-3"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <span className="flex-1 text-[15px] font-semibold">{label}</span>
      <ChevronIcon size={16} dir="right" />
    </a>
  );
}
