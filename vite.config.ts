import { resolve } from 'node:path';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  build: {
    outDir: 'dist',
    ssr: resolve(import.meta.dirname, 'scripts/run.ts'),
  },
  fmt: {
    ignorePatterns: ['.pi/**', 'CHANGELOG.md', 'dist/**'],
    singleQuote: true,
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: ['dist/**'],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
