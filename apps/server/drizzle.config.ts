import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` diffs src/db/schema against migrations/meta and writes new SQL files.
// Hand-written migrations (extensions, roles, RLS) are created with `drizzle-kit generate --custom`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./migrations",
});
