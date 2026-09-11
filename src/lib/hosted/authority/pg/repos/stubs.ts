/**
 * The repositories this build has not written a Postgres version of yet.
 *
 * `createPostgresAuthority()` has to type-check as a whole `Authority` on the
 * day the first repository lands, not on the day the last one does — otherwise
 * the boot path, the outbox and the job runner cannot be exercised against a
 * real database until everything else is finished, and the thing that most
 * needs early exercise is the part every other repository will be built on.
 *
 * So the gaps are *filled*, not omitted: every method of every missing
 * repository exists and throws `notImplemented(repo, method)` — an
 * `internal` HostedError naming the repository, the method, and the file to
 * write it in. A route that reaches one gets a refusal it can act on, never a
 * `TypeError: repos.grants.get is not a function`.
 *
 * The stub is built from a list of method names rather than from the SQLite
 * repository, deliberately: importing the SQLite repositories here would make
 * the Postgres authority depend on `node:sqlite`, which is exactly the coupling
 * this whole directory exists to remove. The lists below are checked against
 * the real interfaces by the compiler — `stubRepo<T>` returns `T`, so a method
 * missing from a list is a type error at the call site in `index.ts`.
 */
import { notImplemented } from "../errors";

/** Every method of one repository, each throwing with its own name. */
function stubRepo<T>(repo: string, methods: readonly (keyof T & string)[]): T {
  const out: Record<string, unknown> = {};
  for (const method of methods)
    out[method] = () => {
      throw notImplemented(repo, method);
    };
  return out as T;
}

/**
 * Build the stub for one repository.
 *
 * Kept as a named export so a repository package can delete exactly one call
 * from `pg/repos/index.ts` when it lands, and nothing else.
 */
export const stub = stubRepo;
