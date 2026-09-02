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

/**
 * How to produce a valid `ORRERY_SECRET_KEY`. One string, so the boot failure,
 * every refused write and the inspector's banner all say the same thing.
 */
export const SECRET_KEY_FIX =
  "Set ORRERY_SECRET_KEY in .env.local to a 32-byte key and restart the server — generate one with `openssl rand -base64 32` (hex is accepted too). Keep the same key: values written under an old one cannot be read back.";

/**
 * The 32 raw bytes of `ORRERY_SECRET_KEY`, or undefined if it is not a key.
 * Accepts base64 (with or without padding) and hex, because both are what the
 * usual one-liners print.
 */
export function decodeSecretKey(raw: string): Buffer | undefined {
  const s = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return buf.length === 32 ? buf : undefined;
}

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
  /**
   * Optional. Encrypts the secret store (`lib/secrets`). Unset means Orrery
   * has nowhere to hold a secret value and says so instead of pretending.
   * Validated for shape only — the bytes never leave `decodeSecretKey`.
   */
  ORRERY_SECRET_KEY: z
    .string()
    .refine((v) => decodeSecretKey(v) !== undefined, `must decode to exactly 32 bytes. ${SECRET_KEY_FIX}`)
    .optional(),
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
    ORRERY_SECRET_KEY: present("ORRERY_SECRET_KEY"),
  });

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = String(i.path[0] ?? "(unknown)");
      const raw = process.env[key] ?? "";
      // A rejected key is still key material — echoing it would put it in the
      // boot log. Say how long it was; that is what makes the error actionable.
      const shown = key === "ORRERY_SECRET_KEY" ? `(${raw.length} chars, hidden)` : JSON.stringify(raw);
      return `  ${key}=${shown} — ${i.message}`;
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
