// 移植元: test/core/services/search_deadline_test.dart
//
// #384 の6ファイルは締切を TransitApiClient 越しにしか触らず、注入しない既定の実時間経過と
// 無期限（SearchDeadline.none）の性質はそちらでは一度も通らない。

import { describe, expect, it } from 'vitest';

import { SearchDeadline } from '../../src/services/search-deadline';
import { durationZero, seconds, type Duration } from '../../src/time';
import { delay } from '../support/delay';

describe('SearchDeadline', () => {
  it('経過が予算未満なら残予算を返し、期限切れにならない', () => {
    let elapsed: Duration = seconds(30);
    const deadline = new SearchDeadline(seconds(120), {
      elapsed: () => elapsed,
    });

    expect(deadline.remaining).toBe(seconds(90));
    expect(deadline.isExpired).toBe(false);

    elapsed = seconds(119);
    expect(deadline.remaining).toBe(seconds(1));
    expect(deadline.isExpired).toBe(false);
  });

  it('経過が予算ちょうどで期限切れになる', () => {
    const deadline = new SearchDeadline(seconds(120), {
      elapsed: () => seconds(120),
    });

    expect(deadline.remaining).toBe(durationZero);
    expect(deadline.isExpired).toBe(true);
  });

  it('予算超過でも残予算は負にならない', () => {
    const deadline = new SearchDeadline(seconds(120), {
      elapsed: () => seconds(500),
    });

    expect(deadline.remaining).toBe(durationZero);
    expect(deadline.isExpired).toBe(true);
  });

  it('既定の経過は実時間で進む', async () => {
    const deadline = new SearchDeadline(seconds(120));

    expect(deadline.remaining).toBeLessThanOrEqual(seconds(120));
    const first = deadline.remaining!;
    await delay(20);

    expect(deadline.remaining!).toBeLessThan(first);
    expect(deadline.isExpired).toBe(false);
  });

  it('無期限の締切は期限切れにならず残予算を持たない', () => {
    const deadline = SearchDeadline.none();

    expect(deadline.isExpired).toBe(false);
    expect(deadline.remaining).toBeNull();
  });
});
