import { readFileSync, writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const MOSS_500 = '#4f9527';
const IVORY = '#fbfcec';

const logo = readFileSync('src/shared/logo.tsx', 'utf8');
const leaf = /<path d="([^"]+)"/u.exec(logo)?.[1];
if (leaf === undefined) throw new Error('logo.tsx から葉のパスを読めない');

/** @param {{ rounded: boolean }} options */
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
