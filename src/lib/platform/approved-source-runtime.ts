/** Fixed owning source composition; it does not approve a plan or mint authority. */
import type { Sql } from "@/lib/controlplane/types";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import {
  isApprovedSourceSnapshotStore, type ApprovedSourceSnapshotStore,
} from "@/lib/controlplane/db/repos/approved-source-snapshots";
import type { SourceBundlePort } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { createOwningSourceBundles, type SourceBundleDeps } from "./source-bundle";

type Bundles = ReturnType<typeof createOwningSourceBundles>;
export interface ApprovedSourceRuntimeOptions {
  resources?: SourceBundleDeps["resources"];
  azureStorage?: SourceBundleDeps["azureStorage"];
  /** PROD-MAN-01 managed source hand-off; absent = Zenith-managed builds refuse. */
  zenithSources?: SourceBundleDeps["zenithSources"];
  sourceBundles?: Omit<SourceBundleDeps, "resources">;
  sourceBundle?: SourceBundlePort;
  sourceSnapshots?: ApprovedSourceSnapshotStore;
}
export interface ApprovedSourceRuntime {
  readonly sourceSnapshots?: ApprovedSourceSnapshotStore;
  readonly sourceBundle: SourceBundlePort;
  readonly readAzureSource: Bundles["readAzureSource"];
}
function unavailable(): never {
  throw new StepFailedError("Execution requires owning PostgreSQL approved source custody; no build source was acquired.");
}
function isolatedAdmission(store: unknown): asserts store is ApprovedSourceSnapshotStore {
  if (process.env.NODE_ENV !== "test" || !isApprovedSourceSnapshotStore(store)) {
    throw new StepFailedError("Source overrides require a recognized isolated test store in the test environment.");
  }
}
/** This is a structural prerequisite of a trusted composition handle, not an executor brand. */
function postgresHandle(db: Sql): db is PlatformDbHandle {
  return "kind" in db && db.kind === "postgres" && "identity" in db && typeof db.identity === "string"
    && typeof db.query === "function" && typeof db.tx === "function"
    && "exec" in db && typeof db.exec === "function" && "close" in db && typeof db.close === "function";
}

export function createApprovedSourceRuntime(db: Sql, options: ApprovedSourceRuntimeOptions = {}): ApprovedSourceRuntime {
  const owningDb = db;
  const configured = options.sourceBundles;
  const directStore = options.sourceSnapshots, bundleStore = configured?.sourceSnapshots;
  const selectedStore = directStore ?? bundleStore;
  const bundleOverride = options.sourceBundle;
  const isolated = directStore !== undefined || bundleStore !== undefined || bundleOverride !== undefined || configured?.fetchImpl !== undefined;
  // Validate authority overrides before spreading dependencies or constructing clients.
  if (isolated) isolatedAdmission(selectedStore);
  if (directStore !== undefined && bundleStore !== undefined && directStore !== bundleStore) throw new StepFailedError("Source fixture stores do not match.");
  if (configured?.withGithubAccess !== undefined) throw new StepFailedError("The owning source connector cannot be overridden.");

  if (!isolated && !postgresHandle(owningDb)) {
    // Source-free local/test composition is usable, but no built-source operation
    // can enter GitHub, a credential lookup, global DB opening or a cloud SDK.
    const sourceBundle: SourceBundlePort = Object.freeze({
      async capture() { unavailable(); }, async verify() { unavailable(); }, async prepare() { unavailable(); },
    });
    return Object.freeze({ sourceBundle, readAzureSource: async () => unavailable() });
  }
  const bundles = createOwningSourceBundles(owningDb, {
    resources: options.resources,
    azureStorage: configured?.azureStorage ?? options.azureStorage, zenithSources: configured?.zenithSources ?? options.zenithSources, limits: configured?.limits ? Object.freeze({ ...configured.limits }) : undefined,
    timeoutMs: configured?.timeoutMs,
    ...(isolated ? { sourceSnapshots: selectedStore, fetchImpl: configured?.fetchImpl } : {}),
  });
  const store = bundles.sourceSnapshots;
  if (!isApprovedSourceSnapshotStore(store)) unavailable();
  const guard = isolated ? () => isolatedAdmission(selectedStore) : () => { if (!postgresHandle(owningDb)) unavailable(); };
  const port = bundleOverride ?? bundles.port;
  // Capture identities once. A later mutation of an isolated fixture object cannot
  // replace its methods, and changing test admission refuses before invoking them.
  const prepare = port.prepare.bind(port), capture = port.capture?.bind(port), verify = port.verify?.bind(port);
  const readAzureSource = bundles.readAzureSource.bind(bundles);
  const sourceBundle: SourceBundlePort = Object.freeze({
    async prepare(...args: Parameters<SourceBundlePort["prepare"]>) { guard(); return prepare(...args); },
    ...(capture ? { async capture(...args: Parameters<NonNullable<SourceBundlePort["capture"]>>) { guard(); return capture(...args); } } : {}),
    ...(verify ? { async verify(...args: Parameters<NonNullable<SourceBundlePort["verify"]>>) { guard(); return verify(...args); } } : {}),
  });
  return Object.freeze({ sourceSnapshots: store, sourceBundle,
    readAzureSource: (...args: Parameters<Bundles["readAzureSource"]>) => { guard(); return readAzureSource(...args); },
  });
}
