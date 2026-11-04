/**
 * A string that refuses to be printed.
 *
 * Private signing keys pass through configuration objects on their way to a
 * signer. Wrapping them means an accidental `JSON.stringify(config)`,
 * template-literal interpolation, `console.log` or error-serialisation prints
 * `[redacted]` instead of the key. The only way to the value is the explicit
 * `reveal()` call, which is greppable.
 *
 * This is defence in depth, not a sandbox: code with a reference can still
 * call `reveal()`.
 */
const REDACTED = "[redacted]";

export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "SecretString([redacted])";
  }
}
