// ---------------------------------------------------------------------------
// Prisma CLI configuration (Prisma 7)
// The datasource URL is read from the environment (DATABASE_URL) and is
// resolved by the Prisma CLI from the project .env file.
// ---------------------------------------------------------------------------
import "dotenv/config";
import path from "node:path";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
