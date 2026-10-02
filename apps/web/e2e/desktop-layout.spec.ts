/// 画面ごとのデスクトップ幅のレイアウト。幅の出し分けは CSS なので、jsdom からは
/// 見えない（PORTING.md「デスクトップ幅の作り分け」）。寸法そのものを実測する。

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { goToResult } from './flows';

const desktop = { width: 1280, height: 900 };
const mobile = { width: 375, height: 812 };

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (value === null) throw new Error('要素が描かれていない');
  return value;
}

for (const [name, viewport] of [
  ['デスクトップ幅', desktop],
  ['モバイル幅', mobile],
] as const) {
  test(`${name}の home は CTA の下、1画面の内側に法的情報のリンクを出す`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');

    const cta = await box(page.getByRole('button', { name: '目的地を選ぶ' }));
    const terms = await box(page.getByRole('link', { name: '利用規約' }));

    expect(terms.y).toBeGreaterThanOrEqual(cta.y + cta.height);
    expect(terms.y + terms.height).toBeLessThanOrEqual(viewport.height);
  });
}

test('デスクトップ幅の home は設定ボタンを出さない', async ({ page }) => {
  // シェルのタブが同じ導線を持つ。ハンドオフのルート計画にも歯車は無い。
  await page.setViewportSize(desktop);
  await page.goto('/');

  await expect(page.getByRole('button', { name: '設定を開く' })).toBeHidden();
});

test('モバイル幅の home は設定ボタンを出す', async ({ page }) => {
  await page.setViewportSize(mobile);
  await page.goto('/');

  await expect(page.getByRole('button', { name: '設定を開く' })).toBeVisible();
});

test('デスクトップ幅の設定は本文を 760px で中央へ寄せる', async ({ page }) => {
  await page.setViewportSize(desktop);
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('設定');

  const main = await box(page.getByRole('main'));

  expect(main.width).toBeLessThanOrEqual(760);
  // 中央寄せ: 左右の余白が等しい。
  expect(Math.round(main.x)).toBe(Math.round(desktop.width - main.x - main.width));
});

test('デスクトップ幅の設定はセクションのラベルをカードの左列へ出す', async ({
  page,
}) => {
  await page.setViewportSize(desktop);
  await page.goto('/');
  await page.getByRole('button', { name: '設定', exact: true }).click();

  const label = await box(page.getByRole('heading', { name: '法的情報' }));
  const card = await box(page.getByRole('link', { name: '利用規約' }));

  // 同じ行に並ぶ（ラベルが上に積まれていない）。
  expect(label.x + label.width).toBeLessThanOrEqual(card.x);
  expect(label.y).toBeLessThan(card.y + card.height);
});

test('モバイル幅の設定はラベルをカードの上へ積む', async ({ page }) => {
  await page.setViewportSize(mobile);
  await page.goto('/home/settings');

  const label = await box(page.getByRole('heading', { name: '法的情報' }));
  const card = await box(page.getByRole('link', { name: '利用規約' }));

  expect(label.y + label.height).toBeLessThanOrEqual(card.y);
});

test('デスクトップ幅の結果は左パネルと全面地図の2カラムになる', async ({
  page,
  upstream,
}) => {
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(desktop);
  await goToResult(page);

  const panel = await box(page.getByTestId('result-panel'));
  const map = await box(page.getByTestId('result-map'));

  // 移植元の splitPanelWidth は 380、ハンドオフは minmax(340px, 400px)。
  expect(panel.width).toBeGreaterThanOrEqual(340);
  expect(panel.width).toBeLessThanOrEqual(400);

  // 地図は右の残り全部で、ビューポートの高さいっぱい。
  expect(map.x).toBeGreaterThanOrEqual(panel.x + panel.width);
  expect(Math.round(map.x + map.width)).toBe(desktop.width);
  expect(map.height).toBeGreaterThan(desktop.height * 0.8);
});

test('デスクトップ幅の結果はページごとではなく左パネルだけがスクロールする', async ({
  page,
  upstream,
}) => {
  // 移植元が #262 で踏んだ形。一括スクロールにすると、ビューポート固定の分割
  // ビューから下部の導線が押し出される。
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 420 });
  await goToResult(page);

  const scrolled = await page
    .getByTestId('result-panel')
    .evaluate((el) => {
      el.scrollTop = 120;
      return el.scrollTop;
    });
  const pageScrolls = await page.evaluate(() => {
    const root = document.scrollingElement;
    if (root === null) throw new Error('scrollingElement が無い');
    return root.scrollHeight > root.clientHeight;
  });

  expect(scrolled).toBeGreaterThan(0);
  expect(pageScrolls).toBe(false);
});

test('モバイル幅の結果は地図を挟んだ縦積みのまま', async ({ page, upstream }) => {
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(mobile);
  await goToResult(page, 'screen');

  const map = await box(page.getByTestId('result-map'));
  const panel = await box(page.getByTestId('result-panel'));

  // 移植元 _RouteMapPreview の固定高 180px。
  expect(Math.round(map.height)).toBe(180);
  expect(panel.y).toBeGreaterThanOrEqual(map.y + map.height);
  expect(Math.round(map.width)).toBe(mobile.width - 36);
});

test('デスクトップ幅の待ち画面は上部バーの下を地図で埋める', async ({
  page,
  upstream,
}) => {
  expect(upstream.unmatched).toEqual([]);
  await page.setViewportSize(desktop);

  // 上流をわざと遅らせて待ち画面に留める。fallback で偽の上流へ渡すので、
  // 記録も応答も普段どおり。
  await page.route(
    (url) => url.pathname.includes('/guidance/plan'),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fallback();
    },
  );

  await page.goto('/');
  await page.getByRole('combobox', { name: '目的地を検索' }).fill('テスト');
  await page.getByRole('option', { name: /テスト公園/ }).click();
  await page.getByRole('button', { name: 'ルートを検索' }).click();
  await expect(page).toHaveURL('/home/loading');

  const map = await box(page.getByTestId('loading-map'));
  const bar = await box(page.getByRole('banner'));

  // 上部バーの真下から、ビューポートの下端まで。
  expect(Math.round(map.y)).toBe(Math.round(bar.y + bar.height));
  expect(Math.round(map.x)).toBe(0);
  expect(Math.round(map.width)).toBe(desktop.width);
  expect(Math.round(map.y + map.height)).toBe(desktop.height);
});

test('デスクトップ幅の日付はカレンダーで選ぶ', async ({ page }) => {
  // Popover の portal と、そこへのフォーカスの行き来は実ブラウザで確かめる。
  await page.clock.setFixedTime(new Date('2026-09-11T12:00:00+09:00'));
  await page.setViewportSize(desktop);
  await page.goto('/');

  await page.getByRole('button', { name: /^出発の日付 / }).click();
  await expect(page.getByRole('grid', { name: '2026年9月' })).toBeVisible();
  await page.getByRole('button', { name: '9月12日 (土)' }).click();

  await expect(page.getByRole('grid')).toBeHidden();
  await expect(page.getByRole('button', { name: /^出発の日付 / })).toHaveText(
    '明日 · 9月12日 (土)',
  );
});

test('モバイル幅の日付は native の日付欄のまま', async ({ page }) => {
  await page.setViewportSize(mobile);
  await page.goto('/');

  await expect(page.getByLabel('出発の日付')).toHaveAttribute('type', 'date');
});

type CdpNode = {
  nodeId: number;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
};

/// 出発の時刻欄の中にある、UA の shadow DOM の部品（[pseudo] 属性で探す）。無ければ undefined。
///
/// 部品は CSS の疑似要素としては読めない。`getComputedStyle(el, '::-webkit-calendar-picker-indicator')`
/// は、Chromium がこの疑似要素を受け付けず、黙って input 本体の値（block）を返す。
/// 実体は UA の shadow DOM にあるので、CDP で直接たどる。
async function timeFieldPart(page: Page, pseudo: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });

  const attr = (n: CdpNode, name: string) => {
    const a = n.attributes ?? [];
    const i = a.indexOf(name);
    return i >= 0 && i % 2 === 0 ? a[i + 1] : undefined;
  };
  const find = (n: CdpNode, pred: (n: CdpNode) => boolean): CdpNode | undefined => {
    if (pred(n)) return n;
    for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) {
      const hit = find(c, pred);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const input = find(root as CdpNode, (n) => attr(n, 'aria-label') === '出発の時刻');
  if (input === undefined) throw new Error('出発の時刻欄が無い');
  const node = find(input, (n) => attr(n, 'pseudo') === pseudo);
  return node === undefined ? undefined : { cdp, node };
}

/// 出発の時刻欄にある UA の時計アイコンの display。
async function clockIconDisplay(page: Page): Promise<string> {
  const part = await timeFieldPart(page, '-webkit-calendar-picker-indicator');
  if (part === undefined) throw new Error('時計アイコンの要素が無い');
  const { computedStyle } = await part.cdp.send('CSS.getComputedStyleForNode', {
    nodeId: part.node.nodeId,
  });
  return computedStyle.find((p) => p.name === 'display')?.value ?? '';
}

test('デスクトップ幅の時刻欄は UA の時計アイコンを出さない', async ({ page }) => {
  // テーマの当たらない黒いアイコンで、ステッパーと役目が重なる。
  await page.setViewportSize(desktop);
  await page.goto('/');

  expect(await clockIconDisplay(page)).toBe('none');
});

test('モバイル幅の時刻欄は UA の時計アイコンを残す', async ({ page }) => {
  // ステッパーを出さない幅では、マウスで時刻を開く手段がこれしかない。
  await page.setViewportSize(mobile);
  await page.goto('/');

  expect(await clockIconDisplay(page)).not.toBe('none');
});

test('時刻欄は 24 時間表記で出す（AM/PM の欄を持たない）', async ({ page }) => {
  // 表記はページではなくブラウザの表示言語で決まる。E2E のブラウザも日本語の
  // 利用者と同じ表示にそろえておく（playwright.config.ts の --lang）。
  await page.setViewportSize(desktop);
  await page.goto('/');

  // 探し方が空振りしていないことを、同じ欄の「時」の部品で確かめる。
  expect(await timeFieldPart(page, '-webkit-datetime-edit-hour-field')).toBeDefined();
  expect(await timeFieldPart(page, '-webkit-datetime-edit-ampm-field')).toBeUndefined();
});
