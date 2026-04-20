import { defineConfig } from 'vite';

// On GitHub Actions we build for the project Pages site at
//   https://<owner>.github.io/DTXmaniaNX/
// so we need a /DTXmaniaNX/ base. Local dev + other CI keep `/`.
const base = process.env.GITHUB_ACTIONS ? '/DTXmaniaNX/' : '/';

export default defineConfig({
  base,
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
