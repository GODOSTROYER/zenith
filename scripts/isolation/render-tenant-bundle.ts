/**
 * Print the isolation bundle of ONE tenant as a Kubernetes List, for the platform's bootstrap identity to
 * `kubectl apply --server-side -f -` (PROD-MAN-04). The bundle is the hostname-egress policy, the
 * system-priority quota and the per-tenant operator access (ServiceAccount, Role, RoleBinding, and the
 * namespace-by-name ClusterRole and binding); it is validated by the same gate the renderer uses before a byte
 * is printed. It is never applied by this script and it never reads a credential.
 *
 *   tsx scripts/isolation/render-tenant-bundle.ts \
 *       --workspace-id ws_1 --environment-id env_1 --workspace-slug acme --environment-slug prod --plan starter \
 *       [--fqdn api.example.com --fqdn '*.cdn.example.com'] [--include tenancy]
 *
 * The substrate comes from the ZENITH_MANAGED_* environment exactly as the control plane reads it (so the
 * engine, runtime class and operator-credential prefix match what the renderer used). `--include tenancy`
 * also prints the namespace baseline (Namespace, ServiceAccount, quota, limits, policies) ahead of the bundle,
 * so a bootstrap run creates a tenant namespace completely.
 *
 * Exit 2: bad arguments or an unconfigured substrate. Exit 3: the bundle failed validation (the message names
 * the rule). Output goes to stdout only.
 */
import { bundleObjects, renderIsolationBundle, validateIsolationBundle } from "@/lib/providers/zenith/isolation-bundle";
import { readSubstrateConfig } from "@/lib/providers/zenith/substrate";
import { renderTenancy } from "@/lib/providers/zenith/tenancy";
import { ZenithError, type ZenithTenant } from "@/lib/providers/zenith/types";

function parse(argv: string[]): { values: Map<string, string[]> } {
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    values.set(a.slice(2), [...(values.get(a.slice(2)) ?? []), v]);
    i++;
  }
  return { values };
}

function main(): number {
  let args: Map<string, string[]>;
  try {
    args = parse(process.argv.slice(2)).values;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const one = (k: string): string => {
    const v = args.get(k);
    if (!v || v.length !== 1) throw new Error(`--${k} is required exactly once`);
    return v[0]!;
  };
  let tenant: ZenithTenant;
  try {
    const plan = one("plan");
    if (plan !== "free" && plan !== "starter" && plan !== "pro") throw new Error("--plan must be free, starter or pro");
    tenant = { workspaceId: one("workspace-id"), environmentId: one("environment-id"), workspaceSlug: one("workspace-slug"), environmentSlug: one("environment-slug"), planTier: plan };
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const cfg = readSubstrateConfig(process.env);
  if (!cfg.configured) {
    process.stderr.write(`${cfg.message}\n`);
    return 2;
  }
  try {
    const bundle = renderIsolationBundle(tenant, cfg.substrate, { egressFqdns: args.get("fqdn") ?? [] });
    validateIsolationBundle(bundle, { tenant, substrate: cfg.substrate });
    const tenancy = (args.get("include") ?? []).includes("tenancy") ? renderTenancy(tenant, cfg.substrate).objects : [];
    process.stdout.write(`${JSON.stringify({ apiVersion: "v1", kind: "List", items: [...tenancy, ...bundleObjects(bundle)] }, null, 2)}\n`);
    for (const n of bundle.notes) process.stderr.write(`note: ${n}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ZenithError) {
      process.stderr.write(`${e.code}: ${e.message}\n`);
      return e.code === "isolation_violation" || e.code === "unsupported" ? 3 : 2;
    }
    throw e;
  }
}

process.exitCode = main();
