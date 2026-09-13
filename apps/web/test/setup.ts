// Testing Library の自動クリーンアップは globalThis.afterEach があるときだけ登録される。
// このプロジェクトは vitest の globals を有効にしていない（テストは describe/it を
// 明示 import する）ため、登録されない——前のテストが描いた DOM が残り、同じ role を
// 2つ見つけて落ちる。原因が「前のテスト」にあるぶん、読み解きに時間がかかる。
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
