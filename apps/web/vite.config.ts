import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // El front consume los contratos desde el código fuente, sin build previo.
    alias: { '@turnos/contracts': fileURLToPath(new URL('../../libs/contracts/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
