import { describe, expect, it } from 'vitest';

import { firstAcceptedInOrder } from '../src/promises';
import { deferred } from './support/deferred';
import { delay } from './support/delay';

describe('firstAcceptedInOrder', () => {
  const even = (n: number): boolean => n % 2 === 0;

  it('先頭が受理されたら、後ろの未決着を待たずに返す', async () => {
    const first = deferred<number>();
    const pending = deferred<number>();
    const race = firstAcceptedInOrder([first.promise, pending.promise], even);
    first.complete(2);
    const result = await race;
    expect(result.index).toBe(0);
    expect(result.values).toEqual([2, undefined]);
  });

  it('前の候補が未決着のうちは、後ろが受理されても返さない', async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    let done = false;
    const race = firstAcceptedInOrder([first.promise, second.promise], even).then(
      (r) => {
        done = true;
        return r;
      },
    );
    second.complete(4);
    await delay(0);
    expect(done, '上位が棄却か受理か分かるまで勝者は決まらない').toBe(false);
    first.complete(2);
    expect((await race).index, '両方受理なら順で先の方').toBe(0);
  });

  it('前の候補が受理されずに決着したら、次に受理された候補を返す', async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const third = deferred<number>();
    const race = firstAcceptedInOrder(
      [first.promise, second.promise, third.promise],
      even,
    );
    second.complete(4);
    first.complete(1);
    const result = await race;
    expect(result.index).toBe(1);
    expect(result.values).toEqual([1, 4, undefined]);
  });

  it('全部が受理されずに決着したら index は null', async () => {
    const result = await firstAcceptedInOrder(
      [Promise.resolve(1), Promise.resolve(3)],
      even,
    );
    expect(result.index).toBeNull();
    expect(result.values).toEqual([1, 3]);
  });

  it('空なら index は null', async () => {
    expect((await firstAcceptedInOrder([], even)).index).toBeNull();
  });

  it('確定する前に拒否された Promise があれば、その拒否で倒れる', async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const race = firstAcceptedInOrder([first.promise, second.promise], even);
    second.completeError(new Error('canceled'));
    await expect(race).rejects.toThrow('canceled');
  });

  it('確定した後に届いた拒否は未処理の拒否にならない', async () => {
    const first = deferred<number>();
    const late = deferred<number>();
    const race = firstAcceptedInOrder([first.promise, late.promise], even);
    first.complete(2);
    expect((await race).index).toBe(0);
    late.completeError(new Error('late'));
    await delay(0);
  });
});
