import "dotenv/config";

import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The suite runs against a dedicated `<database>_test` schema so a test run
 * can never touch development data.
 *
 * TEST_DATABASE_URL wins if it is set. Otherwise the name is derived from
 * DATABASE_URL, so the project works out of the box from the .env file that
 * `npm run db:migrate` already needs.
 */
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and point it at your PostgreSQL server before running tests.",
  );
}

function deriveTestDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "");
  if (!name) {
    throw new Error(`Could not determine a database name from DATABASE_URL: ${url}`);
  }
  parsed.pathname = `/${name}_test`;
  return parsed.toString();
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? deriveTestDatabaseUrl(baseUrl);

const testAuthSecret =
  process.env.AUTH_SECRET ?? "test-secret-0123456789abcdef0123456789abcdef";

/**
 * This module is evaluated in Vitest's *main* process, which is the same
 * process that runs `globalSetup`. `test.env` below is only injected into the
 * test workers, so anything the global setup needs (most importantly the test
 * database URL) has to be published to `process.env` here.
 */
process.env.DATABASE_URL = testDatabaseUrl;
process.env.TEST_DATABASE_URL = testDatabaseUrl;
process.env.DEV_DATABASE_URL = baseUrl;
process.env.AUTH_SECRET = testAuthSecret;
process.env.SESSION_MAX_AGE = "3600";
process.env.COOKIE_SECURE = "false";
process.env.UIDAI_OFFLINE_CERT_PATH = "";
process.env.UIDAI_OFFLINE_CERT_PEM = "";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // All suites share one PostgreSQL schema and one HTTP server on port 3000.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    env: {
      // The app and the test process both talk to the test database.
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
      // The untouched development URL, so the global setup can refuse to run
      // destructive commands against it.
      DEV_DATABASE_URL: baseUrl,
      AUTH_SECRET: testAuthSecret,
      SESSION_MAX_AGE: "3600",
      COOKIE_SECURE: "false",
      UIDAI_OFFLINE_CERT_PATH: "",
      UIDAI_OFFLINE_CERT_PEM: "",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
