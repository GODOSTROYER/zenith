/**
 * Bundle assembly: run every emitter, drop the files with nothing to say, and
 * align the `=` columns so the result reads like hand-written HCL. Split out
 * of the single-file exporter; the code is unchanged.
 */
import {
  acmTf,
  albTf,
  backendTf,
  ecsTf,
  elasticacheTf,
  importsTf,
  networkTf,
  outputsTf,
  providersTf,
  rdsTf,
  route53Tf,
  s3Tf,
  secretsTf,
  sesTf,
  sqsTf,
  tfvarsExample,
  variablesTf,
} from "./emitters";
import type { Environment, Manifest } from "@/lib/domain/types";
import type { ExportFile } from "@/lib/providers/types";

/* ------------------------------ bundle assembly ---------------------------- */

/**
 * Align `=` within each run of simple attribute lines, the way `terraform fmt`
 * would. Cheaper than shipping a formatter, and it means the bundle is already
 * canonical when someone runs `terraform fmt -check` in CI.
 */
export function alignEq(src: string): string {
  const re = /^(\s*)([A-Za-z_"][^=]*?)\s*=\s(.*)$/;
  const out = src.split("\n");
  let group: { i: number; indent: string; key: string; val: string }[] = [];
  const flush = () => {
    if (group.length > 1) {
      const w = Math.max(...group.map((g) => g.key.length));
      for (const g of group) out[g.i] = `${g.indent}${g.key.padEnd(w)} = ${g.val}`;
    }
    group = [];
  };
  out.forEach((line, i) => {
    const m = re.exec(line);
    // A line that opens a nested block or collection ends the run.
    if (!m || /[[{(]$/.test(m[3].trim())) return flush();
    if (group.length && group[0].indent !== m[1]) flush();
    group.push({ i, indent: m[1], key: m[2], val: m[3] });
  });
  flush();
  return out.join("\n");
}

export function terraformFiles(env: Environment, m: Manifest): ExportFile[] {
  const candidates: [string, string][] = [
    ["providers.tf", providersTf()],
    ["backend.tf", backendTf(env)],
    ["variables.tf", variablesTf(env, m)],
    ["network.tf", networkTf(m)],
    ["ecs.tf", ecsTf(m, env)],
    ["secrets.tf", secretsTf(m, env)],
    ["imports.tf", importsTf(m)],
    ["rds.tf", rdsTf(m)],
    ["elasticache.tf", elasticacheTf(m)],
    ["s3.tf", s3Tf(m)],
    ["sqs.tf", sqsTf(m)],
    ["ses.tf", sesTf(m)],
    ["alb.tf", albTf(m)],
    ["acm.tf", acmTf(m)],
    ["route53.tf", route53Tf(m)],
    ["outputs.tf", outputsTf(m)],
    ["terraform.tfvars.example", tfvarsExample(env, m)],
  ];

  return candidates
    .filter(([, content]) => content.trim().length > 0)
    .map(([path, content]) => ({ path, content: alignEq(content) }));
}
