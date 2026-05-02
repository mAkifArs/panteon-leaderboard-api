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
    // Whale-safe Redis ↔ BigInt guard. Three regressions in a row
    // (commits d840707, 6f262ac, and Bug 3 / leaderboard-view.ts:141)
    // came from inline BigInt(<redisString>) or Number(<bigint>) at
    // the Redis sortedset boundary. The redis-bigint.ts module is
    // the only sanctioned crossing point; this rule makes the
    // contract mechanical instead of relying on reviewer vigilance.
    //
    // Scoped to the three files that touch sortedset I/O. Pool
    // counter parses in earnings.ts and pool.ts go through Redis
    // STRING + Postgres ::text — those legitimate BigInt(...) calls
    // would be false positives if this rule fired everywhere.
    //
    // Escape hatch: `// eslint-disable-next-line no-restricted-syntax
    // -- <reason>` with a justification, when a future legitimate
    // pattern lands.
    files: ['src/services/leaderboard.ts', 'src/services/leaderboard-view.ts', 'scripts/seed.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // BigInt(obj.prop) | BigInt(arr[i]) | BigInt(x!) — the
          // shapes that have been real bugs (commits d840707, Bug 3).
          // BigInt(literal) and BigInt(<arithmetic>) stay legal:
          // those are not Redis-sourced strings.
          selector:
            "CallExpression[callee.name='BigInt'] > :matches(MemberExpression, TSNonNullExpression)",
          message:
            'Use redisScoreToBigInt() from src/services/redis-bigint.ts. Inline BigInt(<expr>) breaks on Redis scientific-notation scores past 2^53 (commit d840707, Bug 3).',
        },
        {
          // Number(<id>) — the BigInt-to-Number cast that lost
          // precision in commit 6f262ac. Number(arr[i]) and
          // Number(literal) stay legal (CLI parsing in seed.ts).
          selector: "CallExpression[callee.name='Number'] > Identifier:not([name='Number'])",
          message:
            'Use bigIntToRedisScore() from src/services/redis-bigint.ts when sending a BigInt to Redis. Inline Number(<bigint>) silently rounds past 2^53 (commit 6f262ac).',
        },
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
