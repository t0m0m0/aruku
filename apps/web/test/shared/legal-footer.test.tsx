import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { privacyPolicyUrl, termsOfServiceUrl } from '../../src/config';
import { LegalFooter } from '../../src/shared/legal-footer';

describe('LegalFooter', () => {
  it('リンクは利用規約とプライバシーポリシーだけ', () => {
    render(<LegalFooter />);

    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      '利用規約',
      'プライバシーポリシー',
    ]);
  });

  it.each([
    ['利用規約', termsOfServiceUrl],
    ['プライバシーポリシー', privacyPolicyUrl],
  ])('%s を新しいタブで開く', (name, url) => {
    render(<LegalFooter />);

    const link = screen.getByRole('link', { name });

    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    // target=_blank の暗黙の noopener に頼らない。rel を明示しない <a> は、
    // 古い実装では開いた先から window.opener 経由でこちらを操作できる。
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
