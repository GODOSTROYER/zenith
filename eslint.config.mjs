import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

/**
 * Next.js recommended rules plus TypeScript. A leading underscore marks a
 * parameter that exists to satisfy an interface and is deliberately unused —
 * the provider adapters are full of them.
 */
const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // The hosted contracts directory has one door: `@/lib/hosted/contracts`.
  // Reaching past the barrel makes every file that does so a place the layout
  // of that directory has to stay frozen for. Files inside src/lib/hosted are
  // exempt — that is the subsystem that owns the modules.
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "scripts/**/*.ts", "workers/**/*.ts"],
    ignores: ["src/lib/hosted/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/hosted/contracts/*"],
              message:
                "Import from the barrel: `@/lib/hosted/contracts`. Only files inside src/lib/hosted may reach past it.",
            },
          ],
        },
      ],
    },
  },
  { ignores: ["next-env.d.ts", ".next/**", ".data/**", ".data-*/**", "node_modules/**", "supabase/**", "public/gimbal/basis/**"] },
];

// Named, because `eslint .` lints this file too and flags an anonymous default.
export default config;
