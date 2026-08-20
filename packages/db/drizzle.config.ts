import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema/index.ts', './src/schema/guarded.ts'],
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/duckoj' },
});
