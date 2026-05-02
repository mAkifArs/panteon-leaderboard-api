import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // Worktrees are ephemeral Claude scratch dirs; benchmarks are k6
    // scripts (not Node, no tsconfig); test/setup.ts and the eslint
    // config itself sit outside the typed-lint project so the
    // type-checked rules cannot resolve them. Skip all of these
    // rather than expanding tsconfig include and slowing typecheck.
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'drizzle/**',
      '.claude/**',
      'benchmarks/**',
      'test/setup.ts',
      'eslint.config.js',
    ],
  },
)
