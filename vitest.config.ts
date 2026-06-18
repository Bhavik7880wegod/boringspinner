import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

// Tests are pure-function / adapter dry-run only. No real network (§5.1).
// `vscode` is provided by the host at runtime; alias it to a minimal shim so
// modules that import it can be loaded under vitest.
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/vscode-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
