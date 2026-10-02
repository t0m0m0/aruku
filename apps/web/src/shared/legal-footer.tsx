import { privacyPolicyUrl, termsOfServiceUrl } from '../config';
import { ja } from '../i18n/ja';

/// 利用規約とプライバシーポリシーへのリンク。
///
/// 外部リンクは素の <a>。移植元の url_launcher と「リンクを開けませんでした」の
/// 通知は運ばない——ブラウザではリンクを開くことが失敗し得る操作ではなく、launcher が
/// false を返すという概念自体が無い。
export function LegalFooter() {
  return (
    <footer className="flex justify-center gap-4 text-[12px] font-medium text-ink-3">
      <LegalLink label={ja.legalTermsOfService} href={termsOfServiceUrl} />
      <LegalLink label={ja.legalPrivacyPolicy} href={privacyPolicyUrl} />
    </footer>
  );
}

function LegalLink({ label, href }: { label: string; href: string }) {
  return (
    // rel は target=_blank の暗黙の noopener に任せない。明示しない <a> は、開いた先から
    // window.opener 越しにこちらを操作できる実装が残っている。
    <a
      // 文字は小さくても、押せる高さは HIG の最小タップ寸法に届かせる。
      className="inline-flex min-h-tap-min items-center text-ink-3 underline-offset-2 hover:underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label}
    </a>
  );
}
