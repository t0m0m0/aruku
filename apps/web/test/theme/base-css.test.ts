// base.css が置く共通クラス（.card / .tabular）は、コンポーネント側の CSS Modules と
// 同じ詳細度で競合する。勝ち負けを決めるのは出力順で、出力順を決めるのは main.tsx の
// import 順——つまり import を並べ替えるだけでデザインが変わる。
//
// 実際に壊れていた: `.card` が後に出たため border-radius 18px が勝ち、目的地カードの
// 22px と設定ボタンの 14px を上書きしていた（PR #394 レビュー、実ブラウザで確認）。
//
// @layer に入れるとレイヤー無しのコンポーネント側が常に勝ち、順序に依存しなくなる。
// jsdom はカスケードレイヤーを解釈しないので、振る舞いではなく構造を押さえる。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// import.meta.url は Vite が書き換えるため file: URL とは限らない。vitest の
// カレントは apps/web なので、そこからの相対で読む。
//
// コメントを先に落とす。落とさないと、この決定を説明している散文中の `.card` を
// 規則だと読み、自分の検出を握り潰す（.claude/doc_consistency.py が同じ理由で
// 散文とコードを分けている）。
const css = readFileSync('src/theme/base.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

describe('base.css', () => {
  it.each(['.card', '.tabular'])(
    '%s は @layer の中にあり、コンポーネント側に負ける',
    (selector) => {
      const layerStart = css.indexOf('@layer');

      expect(layerStart).toBeGreaterThanOrEqual(0);
      expect(css.indexOf(selector)).toBeGreaterThan(layerStart);
    },
  );
});
