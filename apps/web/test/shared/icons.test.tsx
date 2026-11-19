import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import * as icons from '../../src/shared/icons';

const components = Object.entries(icons).filter(([name]) => name.endsWith('Icon')) as [
  string,
  () => ReactElement,
][];

describe('アイコン', () => {
  it('取りこぼしなく列挙できている', () => {
    expect(components.map(([name]) => name).sort()).toEqual([
      'CalendarIcon',
      'ChevronIcon',
      'ClockIcon',
      'CloseIcon',
      'CompassIcon',
      'PinIcon',
      'RoutesIcon',
      'SearchIcon',
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
