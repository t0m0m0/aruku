// ODPT の公共交通オープンデータ開発者ガイドライン（2.2.1・3.1）が求める表示（#461）。
// 結果画面のどこに置くかは result-screen.test.tsx が見る。

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { TimetableSource } from '@aruku/engine/models/route-plan';

import { TimetableAttribution } from '../../../src/features/result/timetable-attribution';

const at = (iso: string): Date => new Date(iso);

const toei: TimetableSource = { feedId: 'Toei', fetchedAt: at('2026-06-26T19:23:10Z') };
const jrEast: TimetableSource = { feedId: 'JR-East', fetchedAt: at('2026-06-26T19:23:05Z') };

describe('TimetableAttribution', () => {
  it('公共交通オープンデータセンターのデータであることを出す', () => {
    render(<TimetableAttribution sources={[jrEast]} />);
    screen.getByText(/公共交通オープンデータセンターが提供するデータ/);
  });

  it('正確性・完全性を保証しないことを出す', () => {
    render(<TimetableAttribution sources={[jrEast]} />);
    screen.getByText(/正確性・完全性は保証されません/);
  });

  it('問い合わせ先はアプリで、交通事業者へは問い合わせないよう伝える', () => {
    render(<TimetableAttribution sources={[jrEast]} />);
    screen.getByText(/交通事業者へは問い合わせないでください/);
    const link = screen.getByRole('link', { name: 'あるくへのお問い合わせ' });
    expect(link.getAttribute('href')).toBe('https://github.com/t0m0m0/aruku/issues');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('事業者ごとの取得日時を JST で出す', () => {
    render(<TimetableAttribution sources={[jrEast, toei]} />);
    expect(rowOf('JR東日本')).toContain('2026年6月27日 4:23');
    expect(rowOf('東京都交通局')).toContain('2026年6月27日 4:23');
  });

  // 取得は ODPT 側の時刻で、利用者の端末の時差で変わらない。
  it('端末が JST でなくても JST で出す', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      render(<TimetableAttribution sources={[jrEast]} />);
      expect(rowOf('JR東日本')).toContain('2026年6月27日 4:23');
    } finally {
      process.env.TZ = previous;
    }
  });

  it('知らないフィードは id のまま出す', () => {
    render(
      <TimetableAttribution
        sources={[{ feedId: 'NewRailway', fetchedAt: at('2026-06-26T19:23:05Z') }]}
      />,
    );
    screen.getByText('NewRailway');
  });

  it('都営のデータを使っていれば CC BY 4.0 のクレジットを出す', () => {
    render(<TimetableAttribution sources={[jrEast, toei]} />);
    screen.getByText(/東京都交通局・公共交通オープンデータ協議会/);
    const license = screen.getByRole('link', { name: 'CC BY 4.0' });
    expect(license.getAttribute('href')).toBe(
      'https://creativecommons.org/licenses/by/4.0/deed.ja',
    );
  });

  it('都営のデータを使っていなければ CC BY のクレジットは出さない', () => {
    render(<TimetableAttribution sources={[jrEast]} />);
    expect(screen.queryByText(/CC BY/)).toBeNull();
  });

  // 結果画面の主役は行程（#453）。出典は気になった人が開く。
  it('閉じた状態で置き、見出しから開ける', () => {
    render(<TimetableAttribution sources={[jrEast]} />);
    const details = screen.getByText('時刻表データについて').closest('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
  });

  it('出典が無ければ何も描かない', () => {
    const { container } = render(<TimetableAttribution sources={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

function rowOf(operator: string): string {
  return screen.getByText(operator).closest('li')?.textContent ?? '';
}
