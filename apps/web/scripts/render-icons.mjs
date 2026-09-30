// ファビコンと PWA アイコンを ArukuLogo（src/shared/logo.tsx）から書き出す。
// 絵柄を変えたら logo.tsx を直してから `node scripts/render-icons.mjs` を走らせる。
//
// ラスタライズに Playwright の Chromium を借りるのは、sharp や resvg を足さずに
// 済むから（e2e のために既に devDependency に在る）。

import { readFileSync, writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const MOSS_500 = '#4f9527';
const IVORY = '#fbfcec';

const logo = readFileSync('src/shared/logo.tsx', 'utf8');
const leaf = /<path d="([^"]+)"/u.exec(logo)?.[1];
if (leaf === undefined) throw new Error('logo.tsx から葉のパスを読めない');

// ArukuLogo と同じ比率: 角丸は一辺の 1/3、葉は一辺の 65% の枠に中央寄せ。
// maskable と apple-touch は OS が自前で切り抜くので角を丸めず四隅まで塗る。
// 葉の外接は枠の中心から一辺の 27% 程度に収まり、maskable の安全域（半径 40%）の内側。
function iconSvg({ rounded }) {
  const radius = rounded ? (100 / 3).toFixed(2) : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${radius}" fill="${MOSS_500}"/>
  <g transform="translate(17.5 17.5) scale(${(65 / 24).toFixed(4)})" fill="none" stroke="${IVORY}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="${leaf}"/>
    <circle cx="7" cy="18.5" r="1.4" fill="${IVORY}" stroke="none"/>
  </g>
</svg>
`;
}

const rounded = iconSvg({ rounded: true });
const square = iconSvg({ rounded: false });

writeFileSync('public/icon.svg', rounded);

const targets = [
  { path: 'public/favicon.png', size: 32, svg: rounded },
  { path: 'public/icons/Icon-192.png', size: 192, svg: rounded },
  { path: 'public/icons/Icon-512.png', size: 512, svg: rounded },
  { path: 'public/icons/Icon-maskable-192.png', size: 192, svg: square },
  { path: 'public/icons/Icon-maskable-512.png', size: 512, svg: square },
  { path: 'public/icons/apple-touch-icon.png', size: 180, svg: square },
];

const browser = await chromium.launch();
try {
  for (const { path, size, svg } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path, omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
