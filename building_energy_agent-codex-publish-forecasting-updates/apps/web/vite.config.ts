import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const apiOrigin = process.env.BE_API_ORIGIN ?? `http://127.0.0.1:${process.env.BE_PORT ?? '8787'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': apiOrigin,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
