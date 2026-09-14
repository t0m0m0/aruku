// 移植元: lib/features/settings/settings_screen.dart と settings_widgets.dart。
//
// 移植元の5セクションのうち4つ（通知・ヘルスケア連携・週間目標・OS設定を開く導線）は
// Web に載せない。#386 が「Web で落ちる機能の UI を作らない」と決めた側で、対応する
// 設定値も無いため AppSettings ごと移していない。
//
// セクションの一覧を**完全一致**で押さえる。「通知スイッチが無いこと」のような不在の
// アサーションは、そもそも実装していない間ずっと緑のままで何も検証しない。

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { StoreApi } from 'zustand/vanilla';

import { privacyPolicyUrl, termsOfServiceUrl } from '../../../src/config';
import { SettingsScreen } from '../../../src/features/settings/settings-screen';
import { Screen, screenPath } from '../../../src/navigation/screens';
import { createAppStore, type AppStore } from '../../../src/state/store';

let store: StoreApi<AppStore>;

function setup() {
  const navigate = vi.fn();
  store = createAppStore({}, () => new Date(2026, 8, 14, 12, 0, 0));
  store.getState().attachNavigator(navigate);

  render(<SettingsScreen store={store} />);
  return { navigate };
}

describe('設定画面', () => {
  it('主見出しは見出しレベル1で出る', () => {
    setup();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('設定');
  });

  it('home へ戻れる', () => {
    const { navigate } = setup();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
  });

  // 増えたら落ちる。Web で動かない設定を足し戻したことに気付く唯一の場所。
  it('セクションは権限と法的情報だけ', () => {
    setup();

    const sections = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);

    expect(sections).toEqual(['権限', '法的情報']);
  });

  // 移植元は「位置情報・通知の権限」だったが、通知は Web に無い。
  it('位置情報の権限はブラウザのサイト設定から変えると案内する', () => {
    setup();

    expect(
      screen.getByText('位置情報の権限はブラウザのサイト設定から変更してください'),
    ).toBeDefined();
  });

  it.each([
    ['利用規約', termsOfServiceUrl],
    ['プライバシーポリシー', privacyPolicyUrl],
  ])('%s を新しいタブで開く', (name, url) => {
    setup();

    const link = screen.getByRole('link', { name });

    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    // target=_blank の暗黙の noopener に頼らない。rel を明示しない <a> は、
    // 古い実装では開いた先から window.opener 経由でこちらを操作できる。
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
