import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    // Without this, vitest's default include glob also picks up the compiled
    // CommonJS copies of these same test files under dist/ once `npm run build`
    // has been run, and those fail immediately (vitest can't be require()'d as CJS).
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
