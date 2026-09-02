import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Two environments, split by extension. Component tests need a DOM and the
 * engine/store tests must not have one — a jsdom global in a Node test hides
 * real server-side mistakes (`window` checks that silently pass, timers that
 * behave differently). `extends: true` gives both projects the `@` alias and
 * the timeout below.
 *
 * `*.test.ts`  → node
 * `*.test.tsx` → jsdom  (requires the jsdom devDependency)
 */
export default defineConfig({
  test: {
    testTimeout: 20000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: ["tests/**/*.test.tsx"],
          environment: "jsdom",
        },
      },
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
