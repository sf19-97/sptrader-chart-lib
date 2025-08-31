import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
});