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
  // What this boundary does and does not cover: it stops *static* imports of the
  // guarded module from `apps/api/src` outside `authz/`. It cannot see a dynamic
  // `import()`, and it says nothing about raw SQL — `db.execute(sql`select * from
  // organizations`)` lints clean from anywhere. Neither is a realistic
  // carelessness shape, but the rule must not be read as a total guarantee.
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@duckoj/db/guarded', message: GUARDED_MESSAGE }],
          // Also closes the obvious ways around the exact-name match above:
          // a `.js` suffix, or a deep relative path into the db package.
          patterns: [
            { group: ['@duckoj/db/guarded*', '**/schema/guarded*'], message: GUARDED_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    // `authz/**` is where visibility is decided, so it is the one place inside
    // the restricted scope that must reach the guarded tables. `apps/api/test`
    // and `packages/db` need no exemption — the block above never restricted
    // them — and listing them would advertise holes that do not exist.
    files: ['apps/api/src/authz/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
