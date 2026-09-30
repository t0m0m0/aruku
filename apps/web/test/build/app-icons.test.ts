import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicPath = (href: string) => `public${href}`;

// PNG の寸法は IHDR（先頭 8 バイトの署名の直後のチャンク）の幅・高さに入っている。
function pngSize(path: string): string {
  const bytes = readFileSync(path);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8')) as {
  icons: ManifestIcon[];
};
const indexHtml = readFileSync('index.html', 'utf8');

function linkHref(rel: string, type?: string): string | undefined {
  const links = indexHtml.match(/<link\b[^>]*>/gu) ?? [];
  const link = links.find(
    (tag) =>
      tag.includes(`rel="${rel}"`) && (type === undefined || tag.includes(`type="${type}"`)),
  );
  return link === undefined ? undefined : /href="([^"]+)"/u.exec(link)?.[1];
}

describe('manifest.json のアイコン', () => {
  it.each(manifest.icons)('$src は宣言どおりの寸法の PNG として実在する', (icon) => {
    expect(icon.type).toBe('image/png');
    expect(existsSync(publicPath(icon.src))).toBe(true);
    expect(pngSize(publicPath(icon.src))).toBe(icon.sizes);
  });

  it('通常とマスカブルの両方を 192px と 512px で持つ', () => {
    const declared = manifest.icons.map((icon) => `${icon.purpose ?? 'any'}@${icon.sizes}`);
    expect(declared).toEqual(
      expect.arrayContaining(['any@192x192', 'any@512x512', 'maskable@192x192', 'maskable@512x512']),
    );
  });
});

describe('index.html のアイコン', () => {
  it('SVG のファビコンを持ち、その絵柄はアプリ内のロゴ ArukuLogo と同じ葉である', () => {
    const href = linkHref('icon', 'image/svg+xml');
    expect(href).toBeDefined();
    const svg = readFileSync(publicPath(href!), 'utf8');
    const logo = readFileSync('src/shared/logo.tsx', 'utf8');
    const leaf = /<path d="([^"]+)"/u.exec(logo)?.[1];
    expect(leaf).toBeDefined();
    expect(svg).toContain(`d="${leaf}"`);
  });

  it('SVG を読まないブラウザ向けに 32px の PNG ファビコンを持つ', () => {
    const href = linkHref('icon', 'image/png');
    expect(href).toBeDefined();
    expect(pngSize(publicPath(href!))).toBe('32x32');
  });

  it('apple-touch-icon は iOS の標準寸法 180px の PNG である', () => {
    const href = linkHref('apple-touch-icon');
    expect(href).toBeDefined();
    expect(pngSize(publicPath(href!))).toBe('180x180');
  });
});
