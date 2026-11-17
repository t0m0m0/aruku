import type { TimetableSource } from '@aruku/engine/models/route-plan';

import { contactUrl } from '../../config';
import { fetchedAtLabel } from '../../i18n/format';
import { ja } from '../../i18n/ja';

const toeiFeedId = 'Toei';
const ccBy40Url = 'https://creativecommons.org/licenses/by/4.0/deed.ja';
/// functions/src/timetable-pack/mini-tokyo-3d.ts のフィード id の接頭辞。
const miniTokyo3dFeedPrefix = 'mini-tokyo-3d/';
const miniTokyo3dLabel = 'mini-tokyo-3d';
const miniTokyo3dUrl = 'https://github.com/nagix/mini-tokyo-3d';

/// 経路の選定に使った時刻表（ODPT と mini-tokyo-3d）の出典・取得日時・問い合わせ先（#461・#510）。
///
/// 閉じた状態で置く。結果画面の主役は行程で（#453）、出典は気になった人が開けば足りる。
export function TimetableAttribution({ sources }: { sources: TimetableSource[] }) {
  if (sources.length === 0) return null;
  const odpt = sources.filter((s) => !s.feedId.startsWith(miniTokyo3dFeedPrefix));
  const miniTokyo3d = sources.find((s) => s.feedId.startsWith(miniTokyo3dFeedPrefix));
  const usesToei = odpt.some((s) => s.feedId === toeiFeedId);
  const rows = [
    ...odpt.map((s) => ({
      label: ja.timetableFeedNames[s.feedId] ?? s.feedId,
      fetchedAt: s.fetchedAt,
    })),
    ...(miniTokyo3d === undefined
      ? []
      : [{ label: miniTokyo3dLabel, fetchedAt: miniTokyo3d.fetchedAt }]),
  ];

  return (
    <details className="border-t border-outline-variant pt-2 text-body-medium text-on-surface-variant">
      <summary className="flex min-h-tap-min cursor-pointer items-center text-title-small">
        {ja.timetableAttributionHeading}
      </summary>
      <div className="flex flex-col gap-2 pb-4">
        {odpt.length > 0 && <p>{ja.timetableAttributionSource}</p>}
        <p>{ja.timetableAttributionDisclaimer}</p>
        <p>
          {ja.timetableAttributionContactLead}
          <ExternalLink href={contactUrl}>{ja.timetableAttributionContact}</ExternalLink>
        </p>
        <section>
          <h3 className="text-label-medium">{ja.timetableAttributionFetchedAt}</h3>
          <ul>
            {rows.map((r) => (
              <li key={r.label} className="flex gap-2">
                <span>{r.label}</span>
                <span className="tabular">{fetchedAtLabel(r.fetchedAt)}</span>
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
        {miniTokyo3d !== undefined && (
          <p>
            {ja.timetableAttributionMiniTokyo3dLead}
            <ExternalLink href={miniTokyo3dUrl}>{miniTokyo3dLabel}</ExternalLink>
            {ja.timetableAttributionMiniTokyo3dCredit}
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
