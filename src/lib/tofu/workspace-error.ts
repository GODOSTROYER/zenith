/** Stable, value-free refusal codes shared by workspace validators. */
export class TofuWorkspaceError extends Error {
  readonly code: "invalid_input" | "invalid_fragment" | "duplicate_address" | "unknown_node" | "forbidden_construct" | "digest_mismatch" | "unknown_provider_set";
  constructor(code: TofuWorkspaceError["code"], message: string) {
    super(message);
    this.name = "TofuWorkspaceError";
    this.code = code;
  }
}
