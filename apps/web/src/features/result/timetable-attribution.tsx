import type { TimetableSource } from '@aruku/engine/models/route-plan';

import { contactUrl } from '../../config';
import { fetchedAtLabel } from '../../i18n/format';
import { ja } from '../../i18n/ja';

const toeiFeedId = 'Toei';
const ccBy40Url = 'https://creativecommons.org/licenses/by/4.0/deed.ja';

/// 経路の選定に使った時刻表（ODPT）の出典・取得日時・問い合わせ先（#461）。
///
/// 閉じた状態で置く。結果画面の主役は行程で（#453）、出典は気になった人が開けば足りる。
export function TimetableAttribution({ sources }: { sources: TimetableSource[] }) {
  if (sources.length === 0) return null;
  const usesToei = sources.some((s) => s.feedId === toeiFeedId);

  return (
    <details className="border-t border-outline-variant pt-2 text-body-medium text-on-surface-variant">
      <summary className="flex min-h-tap-min cursor-pointer items-center text-title-small">
        {ja.timetableAttributionHeading}
      </summary>
      <div className="flex flex-col gap-2 pb-4">
        <p>{ja.timetableAttributionSource}</p>
        <p>{ja.timetableAttributionDisclaimer}</p>
        <p>
          {ja.timetableAttributionContactLead}
          <ExternalLink href={contactUrl}>{ja.timetableAttributionContact}</ExternalLink>
        </p>
        <section>
          <h3 className="text-label-medium">{ja.timetableAttributionFetchedAt}</h3>
          <ul>
            {sources.map((s) => (
              <li key={s.feedId} className="flex gap-2">
                <span>{ja.timetableFeedNames[s.feedId] ?? s.feedId}</span>
                <span className="tabular">{fetchedAtLabel(s.fetchedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
        {usesToei && (
          <p>
            {ja.timetableAttributionToeiCredit}
            <ExternalLink href={ccBy40Url}>CC BY 4.0</ExternalLink>
          </p>
        )}
      </div>
    </details>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    // rel は target=_blank の暗黙の noopener に任せない（home-screen.tsx の LegalLink と同じ）。
    <a
      className="text-primary underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
