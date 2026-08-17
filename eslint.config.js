import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const GUARDED_MESSAGE =
  'Guarded tables may only be imported from apps/api/src/authz/**. ' +
  'Add a method to the relevant *.access.ts service instead of querying directly — ' +
  'see spec §8, "No handler filters visibility by hand".';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/migrations/**', '**/src/generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@qhhoj/db/guarded', message: GUARDED_MESSAGE }],
          // Also closes the obvious ways around the exact-name match above:
          // a `.js` suffix, or a deep relative path into the db package.
          patterns: [
            { group: ['@qhhoj/db/guarded*', '**/schema/guarded*'], message: GUARDED_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    // `authz/**` is where visibility is decided, so it must reach the guarded
    // tables; the API's tests must be able to seed them; `packages/db` owns them.
    files: ['apps/api/src/authz/**/*.ts', 'apps/api/test/**/*.ts', 'packages/db/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
