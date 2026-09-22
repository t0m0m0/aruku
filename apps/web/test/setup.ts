// Testing Library の自動クリーンアップは globalThis.afterEach があるときだけ登録される。
// このプロジェクトは vitest の globals を有効にしていない（テストは describe/it を
// 明示 import する）ため、登録されない——前のテストが描いた DOM が残り、同じ role を
// 2つ見つけて落ちる。原因が「前のテスト」にあるぶん、読み解きに時間がかかる。
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// jsdom は matchMedia を実装しない（CSSOM View 未対応。jsdom 29.1.1 で確認）。
// useIsDesktop が触った瞬間に TypeError になるので、幅を答えない matchMedia を敷く。
//
// 本体側で `typeof window.matchMedia` を見て庇わないのは、庇うと本番のブラウザでも
// 静かにモバイルへ倒れる経路ができ、その縮退がどのテストからも見えなくなるため。
// 実装が無いのは jsdom の都合で、製品の都合ではない。
//
// matches を false へ倒すのは移植元（isDesktopLayoutProvider の既定が false）と同じ理由
// ——差し替えを通らない画面テストが、本番に存在しないデスクトップ UI を出さない。
window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});


// jsdom はレイアウトを持たないので scrollIntoView も実装しない（呼ぶと TypeError）。
// matchMedia と同じ理由でここに敷く——本体側で存在を確かめて庇うと、本番でも
// 静かに「送らない」経路ができ、それがどのテストからも見えなくなる。
Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollTo = () => {};
