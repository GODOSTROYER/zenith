/**
 * A strict command-line parser for the harness CLIs.
 *
 * Strict on purpose: an unknown flag is an error. A typo such as
 * `--confirm-billble` must stop the run, not silently turn it into a dry run
 * (or, worse, a different kind of run) that the operator believes is the real one.
 */

export class UsageError extends Error {
  readonly code = "usage";
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ArgSpec {
  booleans: readonly string[];
  strings: readonly string[];
}

export interface ParsedArgs {
  flags: ReadonlySet<string>;
  values: ReadonlyMap<string, string>;
  positional: readonly string[];
}

export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (spec.booleans.includes(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value.`);
      flags.add(name);
    } else if (spec.strings.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value.`);
      if (values.has(name)) throw new UsageError(`--${name} was given twice.`);
      values.set(name, value);
    } else {
      throw new UsageError(`Unknown option --${name}.`);
    }
  }
  return { flags, values, positional };
}
