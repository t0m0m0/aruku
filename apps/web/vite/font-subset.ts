// 同梱する日本語フォントを「この app が実際に描く文字」ぶんへ絞る。
//
// 移植元は GoogleFonts.notoSansJp のランタイム取得で、#382 がやめると決めたもの。
// 素直な代わりは @fontsource-variable/noto-sans-jp をそのまま読み込むことだが、
// あの 124 分割は日本語の「文章」向けで、散らばった UI 文言には噛み合わない
// （実測: 描画される 431 文字のために 839 KB を引く）。絞ると 179 KB になる。

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Plugin } from 'vite';

type ScanState =
  | 'code'
  | 'line'
  | 'block'
  | 'single'
  | 'double'
  | 'template'
  | 'regex';

const stringStates = new Set<ScanState>(['single', 'double', 'template']);

/// `/` を正規表現の始まりと読んでよい直前の文字。
///
/// 「除算になる文字」を挙げて残りを正規表現とする書き方は採れない。`.tsx` では
/// 閉じタグ `</span>` の `/` が `<` の直後に、自己終了タグ `/>` の `/` が `}` や
/// `"` の直後に来る——どれも「除算になる文字」には入らないので正規表現と読まれ、
/// 次の `/` まで走査が飛んで、その間の文字列リテラルが丸ごと語彙から落ちる
/// （PR #403 の Codex 指摘。`result-timeline.tsx` の「→」が実際に落ちていた）。
///
/// 許可する側を挙げると、判断がつかない文字は「正規表現ではない」へ倒れる。
/// 外した場合の損害が非対称なのでこちらを選ぶ——正規表現を見逃しても、その中に
/// 引用符があるときだけ状態がずれる（現在のソースには無い）のに対し、正規表現と
/// 誤読すると任意の長さのソースを黙って飲み込む。
const regexCanFollow = /[(,;=:!&|?\[{]/u;

/// 文字列リテラルの中身だけを取り出す。
///
/// コメントを正規表現で落としてから文字列を拾う素直な実装は採れない。`//` は
/// URL の中に普通に出てくる（`'https://api.transit.ls8h.com'`）ので、行コメントを
/// 素朴に落とすと文字列が途中で切れる。逆に文字列を先に拾うと、コメント内の
/// 引用符で状態がずれる。どちらか一方では足りず、同じ走査で両方を追う必要がある。
///
/// 取りこぼしは豆腐として画面に出るが、出るのはその文言を描く経路に入ったとき
/// だけなので、見落としやすい方向に倒れる。だから曖昧なものは拾う側へ寄せる。
function* scanStringLiterals(source: string): Generator<string> {
  let state: ScanState = 'code';
  // テンプレートリテラルの `${}` は中がコードに戻る。入れ子になるため積む。
  const templateStack: number[] = [];
  let braceDepth = 0;
  let lastSignificant = '';

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (stringStates.has(state) || state === 'regex') {
      if (ch === '\\') {
        // エスケープは次の1文字ごと飛ばす。`'\''` で状態が抜けないようにする。
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

    // ここから state === 'code'
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

/// 描かれ得ない文字を落とす。
///
/// 空白（U+0020 など）は残す。「余白にグリフは要らない」と落とすと、語彙段が
/// その文字を覆わなくなり、ブラウザは空白を描くためのフォントを **次の family へ
/// 探しに行く**——遅延段の latin と 117 を引いて、空白1文字のために 92 KB を
/// 落とした（実ブラウザの network で確認）。描画は成立するので目視では見えない。
///
/// 落とすのは改行・タブ・制御文字だけ。これらはソースの整形であって、
/// テキストとして描かれる位置には出てこない。
function hasGlyph(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || cp === 0x7f) return false;
  return !/[\t\n\r\f\v]/u.test(ch);
}

/// ソース片の集まりから語彙を作る。並びは決定的（コードポイント順）で、
/// 同じ入力からは同じフォントが出る。
export function collectVocabularyFromSources(sources: Iterable<string>): string {
  const chars = new Set<string>();
  for (const source of sources) {
    for (const ch of scanStringLiterals(source)) {
      if (hasGlyph(ch)) chars.add(ch);
    }
  }
  return [...chars].sort().join('');
}

/// index.html から描かれうる文字を拾う。
///
/// タグを丸ごと落とすだけでは足りない。この app で index.html にある日本語は
/// `<meta name="description">` の content 属性の中**だけ**にあり、属性値ごと消える。
/// 抜けるとブラウザはその文字列のために遅延段を引く（実ブラウザで確認。
/// 「電車に乗らず、時間内で最大限歩く」のために 80 KB を取っていた）。
function collectFromHtml(html: string): string[] {
  const attributes = [...html.matchAll(/content\s*=\s*"([^"]*)"/gu)].map(
    (m) => m[1]!,
  );
  const text = html.replace(/<[^>]*>/gu, ' ');
  return [...[text, ...attributes].join(' ').matchAll(/\S/gu)].map((m) => m[0]);
}

/// `root` 配下のソースと `extraSourceDirs` から語彙を集める。
///
/// i18n のモジュールだけを見る実装にはしない。描画される日本語はテンプレート
/// リテラルの形で他へも散っている——`src/i18n/format.ts` の「月」「日」、
/// `src/features/loading/loading-screen.tsx` の「まで · 制限」がそれで、
/// 見落とすとその画面だけが豆腐になる。
///
/// `extraSourceDirs` には `packages/engine/src` が入る。エンジンは alias で
/// ソース直参照され同じバンドルへ入るので、その文字列リテラルは apps/web 自身の
/// ものと同じだけ描かれる——`TimeValue.dateLabel()` の「明日」、
/// `rail-line-names.ts` の路線名がそれ。
export function collectVocabulary(
  root: string,
  extraSourceDirs: readonly string[] = [],
): string {
  const sources: string[] = [];
  const dirs = [join(root, 'src'), ...extraSourceDirs];
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) sources.push(readFileSync(file, 'utf8'));
  }
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  return collectVocabularyFromSources([
    ...sources,
    // HTML を走査器へ直接渡せないので、拾った文字を文字列リテラルの形で与える。
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
  /// Fontsource の woff2 のファイル名。`files/` 配下の名前だけを持つ。
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

/// Fontsource の index.css を読んで、各 @font-face のファイル名と unicode-range を
/// 宣言順のまま返す。順序は捨てない——後勝ちの判定がこの順に乗っている。
export function parseFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  for (const [, body] of css.matchAll(faceBlock)) {
    const file = srcFile.exec(body!)?.[1];
    const declared = rangeDecl.exec(body!)?.[1];
    if (file === undefined || declared === undefined) continue;
    faces.push({ file, ranges: parseRanges(declared) });
  }
  return faces;
}

function parseRanges(declared: string): [number, number][] {
  return declared.split(',').map((part) => {
    const body = part.trim().replace(/^U\+/iu, '');
    const [lo, hi] = body.split('-');
    const start = Number.parseInt(lo!, 16);
    return [start, hi === undefined ? start : Number.parseInt(hi, 16)];
  });
}

/// どの woff2 をどの文字ぶんへ絞るかを決める。
///
/// 文字ごとに1つの face へ割り振る形にはしない。unicode-range が重なったとき当たる
/// face を決めるのは CSS の後勝ちであって、こちらの割り振りではない——自前で決めると
/// 本家が当てる face とずれ、当たった側にグリフが無い状態を作り得る。積を取れば、
/// 当たる face がどれであれ必ずその文字を持っている。
export function subsetPlan(faces: FontFace[], vocabulary: string): SubsetEntry[] {
  const entries: SubsetEntry[] = [];
  for (const face of faces) {
    const chars = [...vocabulary]
      .filter((ch) => {
        const cp = ch.codePointAt(0)!;
        return face.ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
      })
      .join('');
    if (chars.length > 0) entries.push({ file: face.file, chars });
  }
  return entries;
}

/// 連続したコードポイントを `U+3042-3045` の形へ畳む。畳まないと宣言が語彙の
/// 長さぶん伸び、CSS 自体が絞った甲斐を食う。
export function formatUnicodeRange(chars: string): string {
  const points = [...new Set([...chars])]
    .map((ch) => ch.codePointAt(0)!)
    .sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const start = points[i]!;
    while (i + 1 < points.length && points[i + 1] === points[i]! + 1) i++;
    const end = points[i]!;
    const hex = (cp: number) => cp.toString(16).toUpperCase();
    parts.push(start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`);
  }
  return parts.join(',');
}

export interface EmittedFace {
  family: string;
  url: string;
  chars: string;
}

/// 絞ったフォントを指す @font-face を組む。
///
/// unicode-range は語彙ちょうどにする。省くと語彙外の文字にもこの family が当たり、
/// 遅延段（Fontsource の 124 分割）へ落ちずに豆腐で止まる。
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

/// 語彙フォントを配る仮想モジュール。main.tsx がこれを取り込む。
export const fontsModuleId = 'virtual:aruku-fonts.css';
const resolvedFontsModuleId = `\0${fontsModuleId}`;

/// 絞ったフォントの family 名。tokens.css の `--font-jp` が先頭に置く名前と対。
export const subsetFamily = 'Noto Sans JP Subset';

/// 配信パス。ビルドでも dev でも同じ URL にする。dev だけ別経路にすると、
/// 本番で初めて 404 が出る類の食い違いが残る。
const fontDir = 'assets/fonts';

interface SubsetOutput {
  css: string;
  files: Map<string, Uint8Array>;
}

export interface FontSubsetOptions {
  /// `root/src` の外にある、同じバンドルへ入るソース。エンジンのソース直参照が
  /// これにあたる（vite.config.ts の alias と同じ場所を指す）。
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

/// 日本語フォントを語彙ぶんへ絞って配る Vite プラグイン。
///
/// prebuild の npm script にはしない。CI は `npm run build` ではなく `npx vite build` を
/// 直に叩くので（.github/workflows/ci.yml）、script に置くと CI では黙って飛び、
/// フォントの無い dist が「成功」として出てしまう。ビルドの内側に置けば外せない。
export function arukuFontSubset(options: FontSubsetOptions = {}): Plugin {
  let root = process.cwd();
  let pending: Promise<SubsetOutput> | undefined;
  const subsets = () =>
    (pending ??= buildSubsets(root, options.extraSourceDirs ?? []));

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

    // dev には emitFile が無い。同じ URL を自前で返す。
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
            next();
            return;
          }
          res.setHeader('Content-Type', 'font/woff2');
          res.end(body);
        }, next);
      });
    },

    async buildEnd() {
      // 取り込み側が1つでもあれば load が走っているが、走っていなくても
      // ここで作っておく。emitFile は generateBundle より前に済ませる。
      await subsets();
    },

    async generateBundle() {
      for (const [name, source] of (await subsets()).files) {
        this.emitFile({ type: 'asset', fileName: `${fontDir}/${name}`, source });
      }
    },
  };
}
