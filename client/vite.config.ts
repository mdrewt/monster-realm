import { defineConfig } from 'vite';

// M0b: a plain PixiJS app. The client-prediction wasm (vite-plugin-wasm +
// top-level-await) is wired in at M3 when client-wasm is consumed here.
export default defineConfig({
  server: { port: 5290, strictPort: true },
});
