/** Strict flag parsing and bounded JSON input; external text is never code. */
import { open } from "node:fs/promises";
import { CliError, interrupted } from "./errors";
import { MAX_INPUT_BYTES, object } from "./security";

const booleanFlags = new Set(["json", "debug", "follow", "token-stdin", "help"]);
const valueFlags = new Set(["url", "workspace", "timeout", "status", "env", "limit", "cursor", "scope", "input", "idempotency-key", "reason", "args", "digest", "poll-interval"]);
export interface Arguments { words: string[]; flags: Record<string, string | true> }
export function parse(argv: string[]): Arguments {
  const words: string[] = []; const flags: Arguments["flags"] = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) { words.push(arg); continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || (!booleanFlags.has(match[1]) && !valueFlags.has(match[1]))) throw new CliError(2, "invalid_arguments", "Unknown option. See --help.");
    const [, key, inline] = match;
    if (Object.hasOwn(flags, key)) throw new CliError(2, "invalid_arguments", "Duplicate option. See --help.");
    if (booleanFlags.has(key)) {
      if (inline !== undefined) throw new CliError(2, "invalid_arguments", "Boolean options do not take a value.");
      flags[key] = true;
    } else {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith("--")) throw new CliError(2, "invalid_arguments", "An option is missing its value. See --help.");
      flags[key] = value;
    }
  }
  return { words, flags };
}

export function integer(value: string | true | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new CliError(2, "invalid_arguments", `Use an integer between ${min} and ${max}.`);
  }
  return Number(value);
}
export function identifier(value: string | undefined, max = 200): string {
  if (!value || !new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(value)) throw new CliError(2, "invalid_arguments", "Use a valid Zenith identifier.");
  return value;
}
export function required(flags: Arguments["flags"], key: string): string {
  if (typeof flags[key] !== "string") throw new CliError(2, "invalid_arguments", `This command requires --${key}.`);
  return flags[key];
}

export async function readStdin(stdin: AsyncIterable<string | Uint8Array>, signal?: AbortSignal, limit = MAX_INPUT_BYTES): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  const iterator = stdin[Symbol.asyncIterator]();
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(interrupted());
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next.done) break;
      const chunk = Buffer.from(next.value); size += chunk.length;
      if (size > limit) throw new CliError(2, "input_too_large", "Input exceeds its byte limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { if (abort) signal?.removeEventListener("abort", abort); }
}

export async function jsonInput(source: string, stdin: AsyncIterable<string | Uint8Array>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let text: string;
  if (source === "-") text = await readStdin(stdin, signal);
  else if (source.startsWith("@") && source.length > 1) {
    try {
      const handle = await open(source.slice(1), "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error();
        const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_INPUT_BYTES) throw new Error();
        text = buffer.subarray(0, size).toString("utf8");
      } finally { await handle.close(); }
    } catch { throw new CliError(2, "invalid_input", "Could not read a regular JSON file of at most 1 MiB."); }
  } else throw new CliError(2, "invalid_input", "JSON input must be @file.json or - for stdin.");
  try {
    const value: unknown = JSON.parse(text);
    if (!object(value)) throw new Error();
    return value;
  } catch { throw new CliError(2, "invalid_input", "Input must be a JSON object. Its contents are never included in errors."); }
}

export function scopeInput(text: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(text);
    const keys = ["workspaceId", "projectId", "environmentId", "resourceId"];
    if (!object(value) || !Object.hasOwn(value, "workspaceId") || Object.keys(value).some((key) => !keys.includes(key))) throw new Error();
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, identifier(typeof child === "string" ? child : undefined, 100)]));
  } catch { throw new CliError(2, "invalid_scope", "--scope must be a JSON object with workspaceId and optional projectId, environmentId, resourceId identifiers."); }
}
