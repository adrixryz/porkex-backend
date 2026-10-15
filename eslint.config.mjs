import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/backups/**', 'coverage/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'writable',
        setTimeout: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  },
  {
    // Plain CommonJS maintenance scripts, not part of the tsconfig project.
    files: ['scripts/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { process: 'readonly', console: 'readonly', require: 'readonly', __dirname: 'readonly', module: 'writable' }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // ESM test harness running on Node: no types, and fetch is a global there.
    files: ['tests/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-useless-assignment': 'off'
    }
  }
)