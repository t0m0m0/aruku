// 同梱する日本語フォントを「この app が実際に描く文字」ぶんへ絞る。
//
// 移植元は GoogleFonts.notoSansJp のランタイム取得で、#382 がやめると決めたもの。
// 素直な代わりは @fontsource-variable/noto-sans-jp をそのまま読み込むことだが、
// あの 124 分割は日本語の「文章」向けで、散らばった UI 文言には噛み合わない
// （実測: UI 文言 297 文字のために 474 KB を引く）。絞ると 114 KB になる。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type ScanState =
  | 'code'
  | 'line'
  | 'block'
  | 'single'
  | 'double'
  | 'template'
  | 'regex';

const stringStates = new Set<ScanState>(['single', 'double', 'template']);

/// `/` が正規表現の始まりか除算かは、直前の意味のあるトークンでしか決まらない。
/// 識別子・リテラル・閉じ括弧の後なら除算、それ以外なら正規表現。
const dividendEnd = /[\w$)\]]/u;

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
    } else if (ch === '/' && !dividendEnd.test(lastSignificant)) {
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

/// グリフを持たない文字を落とす。空白・制御文字は @font-face が要らない。
function hasGlyph(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return !/\s/u.test(ch) && cp >= 0x20 && cp !== 0x7f;
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

/// index.html から描かれうる文字を拾う。`<title>` と `<meta name="description">` は
/// タブやブラウザ UI 側に出るが、`lang="ja"` のような属性値は出ない——とはいえ
/// 属性の大半は ASCII で、選り分ける労力に見合わない。タグだけ落として残りを取る。
function collectFromHtml(html: string): string[] {
  return [...html.replace(/<[^>]*>/gu, ' ').matchAll(/\S/gu)].map((m) => m[0]);
}

/// `root` 配下のソースから語彙を集める。
///
/// i18n のモジュールだけを見る実装にはしない。描画される日本語はテンプレート
/// リテラルの形で他へも散っている——`src/i18n/format.ts` の「月」「日」、
/// `src/features/loading/loading-screen.tsx` の「まで · 制限」がそれで、
/// 見落とすとその画面だけが豆腐になる。
export function collectVocabulary(root: string): string {
  const sources: string[] = [];
  for (const file of sourceFiles(join(root, 'src'))) {
    sources.push(readFileSync(file, 'utf8'));
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
