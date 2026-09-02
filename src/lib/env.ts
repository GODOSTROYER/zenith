/**
 * Every `ORRERY_*` variable the server reads, in one validated place.
 *
 * Before this module the 13 reads were scattered and ad-hoc: a typo in
 * `ORRERY_FAST` silently meant "slow", and `ORRERY_LLM_MODEL` — which decides
 * which model you pay for — was documented nowhere at all.
 *
 * Two deliberate exclusions:
 *
 *  - `NEXT_PUBLIC_*` (the Supabase keys) must stay as literal
 *    `process.env.NEXT_PUBLIC_…` expressions in `lib/supabase/env.ts`. Next
 *    inlines those at build time by matching the literal text; reading them
 *    through a function yields `undefined` in the browser bundle.
 *  - Provider credentials (`AWS_ACCESS_KEY_ID`, `SUPABASE_SERVICE_ROLE_KEY`,
 *    `ANTHROPIC_API_KEY`) are presence-only flags here. Their values stay at
 *    their single call site, so this module never becomes somewhere a secret
 *    can be read from by accident.
 *
 * Parsed on every call rather than memoised: the scripts and the test suite
 * both set `ORRERY_DATA` at runtime before importing anything, and a cached
 * snapshot would silently ignore them.
 */
import path from "node:path";
import { z } from "zod";

/** The model that translates Navigator goals when a key is configured. */
export const DEFAULT_LLM_MODEL = "claude-opus-5";

const Schema = z.object({
  /** Data directory: JSON snapshot plus the event and audit logs. */
  ORRERY_DATA: z.string().min(1).default(path.join(process.cwd(), ".data")),
  /** "1" collapses simulated step durations. Anything else is off. */
  ORRERY_FAST: z.enum(["0", "1"]).default("0"),
  /** LocalStack's edge endpoint. */
  ORRERY_LOCALSTACK_ENDPOINT: z.string().url().default("http://localhost:4566"),
  /** Model id for the Navigator's optional language front-end. */
  ORRERY_LLM_MODEL: z.string().min(1).default(DEFAULT_LLM_MODEL),
  /** Lowest level `lib/log.ts` emits. */
  ORRERY_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type OrreryEnv = Omit<z.infer<typeof Schema>, "ORRERY_FAST"> & {
  /** True only when ORRERY_FAST is exactly "1". */
  ORRERY_FAST: boolean;
};

/** An unset variable and one set to "" mean the same thing: use the default. */
const present = (key: string): string | undefined => {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v;
};

/**
 * Validated view of the environment. Throws with the offending variable, what
 * it received and what it accepts — the failure a misconfigured deployment
 * should get at boot, instead of a confusing default three screens later.
 */
export function env(): OrreryEnv {
  const parsed = Schema.safeParse({
    ORRERY_DATA: present("ORRERY_DATA"),
    ORRERY_FAST: present("ORRERY_FAST"),
    ORRERY_LOCALSTACK_ENDPOINT: present("ORRERY_LOCALSTACK_ENDPOINT"),
    ORRERY_LLM_MODEL: present("ORRERY_LLM_MODEL"),
    ORRERY_LOG_LEVEL: present("ORRERY_LOG_LEVEL"),
  });

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = String(i.path[0] ?? "(unknown)");
      return `  ${key}=${JSON.stringify(process.env[key] ?? "")} — ${i.message}`;
    });
    throw new Error(
      `Invalid environment:\n${lines.join("\n")}\n\nFix these in .env.local (see .env.local.example) or in the process environment, then start again.`
    );
  }

  return { ...parsed.data, ORRERY_FAST: parsed.data.ORRERY_FAST === "1" };
}

/** Which optional integrations this process has keys for. Never the values. */
export function configured(): { anthropic: boolean; awsCredentials: boolean } {
  return {
    anthropic: !!present("ANTHROPIC_API_KEY"),
    awsCredentials: !!present("AWS_ACCESS_KEY_ID"),
  };
}
