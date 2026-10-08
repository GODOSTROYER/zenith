import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@": resolve(process.cwd(), "src") } },
  test: { environment: "node", include: ["scripts/acceptance/live/**/*.test.ts"], testTimeout: 20_000 },
});
