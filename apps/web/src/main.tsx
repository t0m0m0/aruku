import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';

// 語彙段——UI 文言ぶんへ絞った Noto Sans JP（vite/font-subset.ts が生成する）。
import 'virtual:aruku-fonts.css';
// 遅延段——語彙外の文字（地点名など任意の日本語）を unicode-range で受け持つ。
// 124 分割のうち、実際に描かれた文字の塊だけがブラウザに取得される。
import '@fontsource-variable/noto-sans-jp';

import './theme/base.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root が index.html に見つからない');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
