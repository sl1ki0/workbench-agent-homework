import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.agent/**'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  { files: ['**/*.ts'], rules: { 'no-control-regex': 'off' } },
);
