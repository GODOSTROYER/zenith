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
 * Read on every call rather than memoised: the scripts and the test suite
 * both set `ORRERY_DATA` at runtime before importing anything, and a cached
 * snapshot would silently ignore them. The nine raw values ARE re-read every
 * time; only the zod parse of an unchanged set of them is reused, so a
 * mid-process change is still picked up on the very next call.
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
 * How to make email alert delivery work. One string, so the env validation
 * error, the refused send and the channel's plan all say the same thing.
 */
export const SMTP_FIX =
  "Set ORRERY_SMTP_URL in .env.local to smtp://user:pass@host:port (smtps:// for implicit TLS) and ORRERY_ALERT_FROM to the address the mail comes from, then restart the server. Webhook and Slack channels need neither.";

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
   * How long the engine waits on one provider step before failing it. Default
   * is generous (5 min): the slowest honest step in the catalog is a 45s ECR
   * push, and a real cloud can be slower than its own estimate.
   */
  ORRERY_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60_000),
  /**
   * Optional. Encrypts the secret store (`lib/secrets`). Unset means Zenith
   * has nowhere to hold a secret value and says so instead of pretending.
   * Validated for shape only — the bytes never leave `decodeSecretKey`.
   */
  ORRERY_SECRET_KEY: z
    .string()
    .refine((v) => decodeSecretKey(v) !== undefined, `must decode to exactly 32 bytes. ${SECRET_KEY_FIX}`)
    .optional(),
  /**
   * Optional. The SMTP server email alert channels send through. Unset means an
   * email channel refuses to send and says so — webhook and Slack channels are
   * unaffected. The password is in this string, so it never reaches a response.
   */
  ORRERY_SMTP_URL: z
    .string()
    .refine(
      (v) => /^smtps?:\/\/.+/.test(v.trim()),
      `must be an SMTP URL. ${SMTP_FIX}`
    )
    .optional(),
  /** Optional. The From address on alert email. Required alongside ORRERY_SMTP_URL. */
  ORRERY_ALERT_FROM: z
    .string()
    .refine(
      (v) => /.+@.+\..+/.test(v.trim()),
      'must contain an email address, e.g. "Zenith <orrery@example.com>" or "orrery@example.com".'
    )
    .optional(),
});

export type ZenithEnv = Omit<z.infer<typeof Schema>, "ORRERY_FAST"> & {
  /** True only when ORRERY_FAST is exactly "1". */
  ORRERY_FAST: boolean;
};

/** An unset variable and one set to "" mean the same thing: use the default. */
const present = (key: string): string | undefined => {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v;
};

/** Exactly the variables `Schema` describes, in one place: read, then parse. */
const RAW_KEYS = [
  "ORRERY_DATA",
  "ORRERY_FAST",
  "ORRERY_LOCALSTACK_ENDPOINT",
  "ORRERY_LLM_MODEL",
  "ORRERY_LOG_LEVEL",
  "ORRERY_STEP_TIMEOUT_MS",
  "ORRERY_SECRET_KEY",
  "ORRERY_SMTP_URL",
  "ORRERY_ALERT_FROM",
] as const;

/**
 * The last successful parse, and the exact raw input that produced it. Values
 * are read fresh every call; this only saves re-running zod when nothing the
 * schema looks at has moved. A failed parse is never cached, so a broken
 * environment throws the same error every time it is asked.
 */
let memo: { fingerprint: string; data: z.infer<typeof Schema> } | undefined;

/**
 * Validated view of the environment. Throws with the offending variable, what
 * it received and what it accepts — the failure a misconfigured deployment
 * should get at boot, instead of a confusing default three screens later.
 */
export function env(): ZenithEnv {
  const raw: Record<string, string | undefined> = {};
  // `cwd` is part of the input: an unset ORRERY_DATA defaults to `.data` under
  // it, and the scripts chdir.
  let fingerprint = process.cwd();
  for (const key of RAW_KEYS) {
    const value = present(key);
    raw[key] = value;
    // Length-prefixed so no value can forge the boundary between two of them.
    // `present()` collapses unset and empty, so "" is unambiguous here.
    fingerprint += `|${key}:${value === undefined ? -1 : value.length}:${value ?? ""}`;
  }

  if (memo?.fingerprint !== fingerprint) {
    const parsed = Schema.safeParse(raw);

    if (!parsed.success) {
      const lines = parsed.error.issues.map((i) => {
        const key = String(i.path[0] ?? "(unknown)");
        const rawValue = process.env[key] ?? "";
        // A rejected key is still key material, and a rejected SMTP URL still
        // carries a password — echoing either would put it in the boot log. Say
        // how long it was; that is what makes the error actionable.
        const secretish = key === "ORRERY_SECRET_KEY" || key === "ORRERY_SMTP_URL";
        const shown = secretish ? `(${rawValue.length} chars, hidden)` : JSON.stringify(rawValue);
        return `  ${key}=${shown} — ${i.message}`;
      });
      throw new Error(
        `Invalid environment:\n${lines.join("\n")}\n\nFix these in .env.local (see .env.local.example) or in the process environment, then start again.`
      );
    }

    memo = { fingerprint, data: parsed.data };
  }

  return { ...memo.data, ORRERY_FAST: memo.data.ORRERY_FAST === "1" };
}

/** Which optional integrations this process has keys for. Never the values. */
export function configured(): { anthropic: boolean; awsCredentials: boolean } {
  return {
    anthropic: !!present("ANTHROPIC_API_KEY"),
    awsCredentials: !!present("AWS_ACCESS_KEY_ID"),
  };
}
