import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Plugin } from 'vite';

type ScanState = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex';

const stringStates = new Set<ScanState>(['single', 'double', 'template']);

const regexCanFollow = /[(,;=:!&|?[{]/u;

function* scanStringLiterals(source: string): Generator<string> {
  let state: ScanState = 'code';
  const templateStack: number[] = [];
  let braceDepth = 0;
  let lastSignificant = '';

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (stringStates.has(state) || state === 'regex') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (state === 'single' && ch === "'") state = 'code';
      else if (state === 'double' && ch === '"') state = 'code';
      else if (state === 'regex' && ch === '/') state = 'code';
      else if (state === 'template' && ch === '`') state = 'code';
      else if (state === 'template' && ch === '$' && next === '{') {
        templateStack.push(braceDepth);
        braceDepth++;
        state = 'code';
        i++;
      } else if (stringStates.has(state)) {
        yield ch;
      }
      continue;
    }

    if (state === 'line') {
      if (ch === '\n') state = 'code';
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'line';
      i++;
    } else if (ch === '/' && next === '*') {
      state = 'block';
      i++;
    } else if (ch === '/' && regexCanFollow.test(lastSignificant)) {
      state = 'regex';
    } else if (ch === "'") state = 'single';
    else if (ch === '"') state = 'double';
    else if (ch === '`') state = 'template';
    else if (ch === '{') braceDepth++;
    else if (ch === '}') {
      braceDepth--;
      if (templateStack.length > 0 && templateStack.at(-1) === braceDepth) {
        templateStack.pop();
        state = 'template';
      }
    }

    if (!/\s/u.test(ch)) lastSignificant = ch;
  }
}

function codePointOf(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) throw new Error('codePointOf: empty string');
  return cp;
}

function codePointHex(cp: number): string {
  return cp.toString(16).toUpperCase();
}

function hasGlyph(ch: string): boolean {
  const cp = codePointOf(ch);
  if (cp < 0x20 || cp === 0x7f) return false;
  return !/[\t\n\r\f\v]/u.test(ch);
}

export function collectVocabularyFromSources(sources: Iterable<string>): string {
  const chars = new Set<string>();
  for (const source of sources) {
    for (const ch of scanStringLiterals(source)) {
      if (hasGlyph(ch)) chars.add(ch);
    }
  }
  return [...chars].sort().join('');
}

function collectFromHtml(html: string): string[] {
  const attributes = [...html.matchAll(/content\s*=\s*"([^"]*)"/gu)].map((m) => m[1]);
  const text = html.replace(/<[^>]*>/gu, ' ');
  return [...[text, ...attributes].join(' ').matchAll(/\S/gu)].map((m) => m[0]);
}

export function collectVocabulary(root: string, extraSourceDirs: readonly string[] = []): string {
  const sources: string[] = [];
  const dirs = [join(root, 'src'), ...extraSourceDirs];
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) sources.push(readFileSync(file, 'utf8'));
  }
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  return collectVocabularyFromSources([
    ...sources,
    `'${collectFromHtml(html).join('').replaceAll('\\', '').replaceAll("'", '')}'`,
  ]);
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/u.test(entry.name)) yield path;
  }
}

export interface FontFace {
  file: string;
  ranges: [number, number][];
}

export interface SubsetEntry {
  file: string;
  chars: string;
}

const faceBlock = /@font-face\s*\{([^}]*)\}/gu;
const srcFile = /url\([^)]*?([\w-]+\.woff2)\)/u;
const rangeDecl = /unicode-range:\s*([^;]+);/u;

export function parseFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  for (const [, body] of css.matchAll(faceBlock)) {
    const file = srcFile.exec(body)?.[1];
    const declared = rangeDecl.exec(body)?.[1];
    if (file === undefined || declared === undefined) continue;
    faces.push({ file, ranges: parseRanges(declared) });
  }
  return faces;
}

function parseRanges(declared: string): [number, number][] {
  return declared.split(',').map((part) => {
    const body = part.trim().replace(/^U\+/iu, '');
    const bounds = body.split('-');
    const [lo] = bounds;
    const hi = bounds.at(1);
    const start = Number.parseInt(lo, 16);
    return [start, hi === undefined ? start : Number.parseInt(hi, 16)];
  });
}

export function subsetPlan(faces: FontFace[], vocabulary: string): SubsetEntry[] {
  const entries: SubsetEntry[] = [];
  for (const face of faces) {
    // oxlint-disable-next-line typescript/no-misused-spread
    const chars = [...vocabulary]
      .filter((ch) => {
        const cp = codePointOf(ch);
        return face.ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
      })
      .join('');
    if (chars.length > 0) entries.push({ file: face.file, chars });
  }
  return entries;
}

export function formatUnicodeRange(chars: string): string {
  const points = [...new Set(chars)].map(codePointOf).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const start = points[i];
    while (i + 1 < points.length && points[i + 1] === points[i] + 1) i++;
    const end = points[i];
    parts.push(
      start === end ? `U+${codePointHex(start)}` : `U+${codePointHex(start)}-${codePointHex(end)}`,
    );
  }
  return parts.join(',');
}

export interface EmittedFace {
  family: string;
  url: string;
  chars: string;
}

export function buildFontFaceCss(faces: EmittedFace[]): string {
  return faces
    .map(
      ({ family, url, chars }) => `@font-face {
  font-family: '${family}';
  font-style: normal;
  font-display: swap;
  font-weight: 100 900;
  src: url(${url}) format('woff2-variations');
  unicode-range: ${formatUnicodeRange(chars)};
}`,
    )
    .join('\n');
}

export const fontsModuleId = 'virtual:aruku-fonts.css';
const resolvedFontsModuleId = `\0${fontsModuleId}`;

export const subsetFamily = 'Noto Sans JP Subset';

const fontDir = 'assets/fonts';

interface SubsetOutput {
  css: string;
  files: Map<string, Uint8Array>;
}

export interface FontSubsetOptions {
  extraSourceDirs?: readonly string[];
}

async function buildSubsets(
  root: string,
  extraSourceDirs: readonly string[],
): Promise<SubsetOutput> {
  const { createRequire } = await import('node:module');
  const { createHash } = await import('node:crypto');
  const subsetFont = (await import('subset-font')).default;

  const require = createRequire(import.meta.url);
  const indexCss = require.resolve('@fontsource-variable/noto-sans-jp/index.css');
  const filesDir = join(dirname(indexCss), 'files');

  const vocabulary = collectVocabulary(root, extraSourceDirs);
  const plan = subsetPlan(parseFontFaces(readFileSync(indexCss, 'utf8')), vocabulary);

  const files = new Map<string, Uint8Array>();
  const faces: EmittedFace[] = [];
  for (const { file, chars } of plan) {
    const source = readFileSync(join(filesDir, file));
    const subset = await subsetFont(source, chars, { targetFormat: 'woff2' });
    const hash = createHash('sha256').update(subset).digest('hex').slice(0, 8);
    const name = `${file.replace(/\.woff2$/u, '')}-${hash}.woff2`;
    files.set(name, subset);
    faces.push({ family: subsetFamily, url: `/${fontDir}/${name}`, chars });
  }
  return { css: buildFontFaceCss(faces), files };
}

export function arukuFontSubset(options: FontSubsetOptions = {}): Plugin {
  let root = process.cwd();
  let pending: Promise<SubsetOutput> | undefined;
  const subsets = () => (pending ??= buildSubsets(root, options.extraSourceDirs ?? []));

  return {
    name: 'aruku:font-subset',

    configResolved(config) {
      root = config.root;
    },

    resolveId(id) {
      return id === fontsModuleId ? resolvedFontsModuleId : undefined;
    },

    async load(id) {
      if (id !== resolvedFontsModuleId) return undefined;
      return (await subsets()).css;
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.replace(`/${fontDir}/`, '');
        if (req.url === undefined || !req.url.startsWith(`/${fontDir}/`)) {
          next();
          return;
        }
        void subsets().then(({ files }) => {
          const body = name === undefined ? undefined : files.get(name);
          if (body === undefined) {
            // oxlint-disable-next-line promise/no-callback-in-promise
            next();
            return;
          }
          res.setHeader('Content-Type', 'font/woff2');
          res.end(body);
        }, next);
      });
    },

    async buildEnd() {
      await subsets();
    },

    async generateBundle() {
      for (const [name, source] of (await subsets()).files) {
        this.emitFile({ type: 'asset', fileName: `${fontDir}/${name}`, source });
      }
    },
  };
}
