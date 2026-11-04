/**
 * Errors the OCI drivers raise from `compile`. Compilation is pure and runs
 * before any credential exists, so these are input errors: the graph asks for
 * something the OCI drivers cannot realize safely, and the honest answer is to
 * stop with a message that names the node, not to emit a best-effort fragment.
 *
 *   OciCompileError      the node's spec / context is malformed for OCI
 *   OciUnsupportedError  a valid request OCI (or this driver) cannot satisfy;
 *                        the message says what the user can do instead
 *
 * Messages carry node addresses and spec-derived names only. They never carry
 * secret values (a driver never reads one).
 */
export class OciCompileError extends Error {
  readonly code = "oci_compile_invalid";
  constructor(message: string) {
    super(message);
    this.name = "OciCompileError";
  }
}

export class OciUnsupportedError extends Error {
  readonly code = "oci_unsupported";
  constructor(message: string) {
    super(message);
    this.name = "OciUnsupportedError";
  }
}
