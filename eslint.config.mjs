import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Flat ESLint config.
 *
 * `eslint-config-next` v16 ships native flat-config arrays, so they are
 * composed directly (no FlatCompat shim).
 */
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      // Prisma's generated client is machine output, not hand-written source.
      "src/generated/**",
      "next-env.d.ts",
      "*.log",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default config;
