import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'out/**', '.test-build/**', 'node_modules/**', 'src/types/git.d.ts', '.vscode-test/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.cjs'], languageOptions: { globals: { require: 'readonly', process: 'readonly', console: 'readonly', __dirname: 'readonly', module: 'readonly' } }, rules: { '@typescript-eslint/no-require-imports': 'off' } }
);
