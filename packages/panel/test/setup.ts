import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('link[data-petalbot-plugin]').forEach((link) => {
    link.remove();
  });
});
