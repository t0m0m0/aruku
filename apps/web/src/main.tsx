import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';

const container = document.getElementById('root');
if (container === null) throw new Error('#root が index.html に見つからない');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
