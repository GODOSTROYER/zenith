/**
 * Explicitly awaited PostgREST repository boundary.
 *
 * The existing `restSync` bridge remains for synchronous contracts that have
 * not yet been widened. New request code should use this repository: its
 * promise is the operation's completion point, and missing tenant context is a
 * refusal rather than an implicit whole-table read.
 */
import { eq, restAsync, type RestAsyncOptions, type RestRequest, type RestResult } from "./sync-rest";

export interface AsyncRepositoryContext {
  tenantId: string;
  authorization?: string;
  signal?: AbortSignal;
}

export interface AsyncRepositoryRequest extends RestRequest {
  /** Set to null only for an explicitly install-global query. */
  tenantColumn?: string | null;
}

export interface AsyncRepository {
  request(req: AsyncRepositoryRequest, context: AsyncRepositoryContext): Promise<RestResult>;
}

function scopedPath(path: string, column: string | null | undefined, tenantId: string): string {
  if (column === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${eq(column ?? "workspace_id", tenantId)}`;
}

/** A small injectable repository, suitable for route handlers and tests. */
export class PostgrestAsyncRepository implements AsyncRepository {
  constructor(private readonly options: RestAsyncOptions = {}) {}

  async request(req: AsyncRepositoryRequest, context: AsyncRepositoryContext): Promise<RestResult> {
    const tenantId = context.tenantId.trim();
    if (!tenantId)
      throw new Error(
        `Postgres store refused ${req.op} "${req.table}": a tenant is required for async storage access.`
      );
    return restAsync(
      { ...req, path: scopedPath(req.path, req.tenantColumn, tenantId) },
      {
        ...this.options,
        authorization: context.authorization ?? this.options.authorization,
        signal: context.signal ?? this.options.signal,
      }
    );
  }
}

export const createAsyncRepository = (options: RestAsyncOptions = {}): AsyncRepository =>
  new PostgrestAsyncRepository(options);
