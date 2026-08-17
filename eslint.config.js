import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/migrations/**', '**/src/generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
