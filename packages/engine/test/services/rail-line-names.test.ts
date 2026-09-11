// 移植元: test/core/services/rail_line_names_test.dart
//
// パーサのテストは railLineLabel を「路線名が和名になる」経路でしか通らず、未知コード・
// null の素通しは一度も実行されない。

import { describe, expect, it } from 'vitest';

import { railLineLabel } from '../../src/services/rail-line-names';

describe('railLineLabel', () => {
  it('私鉄の路線記号コードを和名へ写す', () => {
    expect(railLineLabel('OH')).toBe('小田急小田原線');
    expect(railLineLabel('IN')).toBe('京王井の頭線');
    expect(railLineLabel('KO')).toBe('京王線');
  });

  it('既に和名のもの（JR など）はそのまま返す', () => {
    expect(railLineLabel('山手線（内回り）')).toBe('山手線（内回り）');
    expect(railLineLabel('中央線快速')).toBe('中央線快速');
  });

  it('未知コードはそのまま返す', () => {
    expect(railLineLabel('ZZ')).toBe('ZZ');
  });

  it('null は null', () => {
    expect(railLineLabel(null)).toBeNull();
  });
});
