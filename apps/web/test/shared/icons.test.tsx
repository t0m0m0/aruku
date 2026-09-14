// 移植元: lib/shared/icons/ic.dart。
//
// 形は目で見るしかないので、テストが押さえるのは読み上げへの漏れだけ。アイコンを
// 足すときに aria-hidden を忘れると、スクリーンリーダーが無名の graphic を読み上げ、
// ボタンの読み上げ名にも混ざる。一覧で回して忘れを落とす。

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import * as icons from '../../src/shared/icons';

const components = Object.entries(icons).filter(
  ([name]) => name.endsWith('Icon'),
) as [string, () => ReactElement][];

describe('アイコン', () => {
  it('取りこぼしなく列挙できている', () => {
    expect(components.map(([name]) => name).sort()).toEqual([
      'ChevronIcon',
      'ClockIcon',
      'CloseIcon',
      'CompassIcon',
      'PinIcon',
      'RoutesIcon',
      'SearchIcon',
      'SettingsIcon',
      'TrainIcon',
      'WalkIcon',
    ]);
  });

  it.each(components)('%s は読み上げ対象にならない', (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });
});
