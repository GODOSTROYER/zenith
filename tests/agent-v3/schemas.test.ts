/** No semantic tool accepts model-supplied approval or ambient authority. */
import { expect, it } from "vitest";
import { TOOL_NAMES } from "@/lib/agent-access/v3/contract";
import { TOOL_SCHEMAS } from "@/lib/agent-access/v3/catalog";
import { argsFor } from "./support";

it.each(TOOL_NAMES)("%s rejects all approval members and unknown nested target members", (name) => {
  for (const key of ["approved", "approval", "approvedBy"]) expect(TOOL_SCHEMAS[name].safeParse({ ...argsFor(name), [key]: true }).success).toBe(false);
  const args = argsFor(name);
  expect(TOOL_SCHEMAS[name].safeParse(args).success).toBe(true);
  if (args.target) expect(TOOL_SCHEMAS[name].safeParse({ ...args, target: { ...(args.target as object), approval: true } }).success).toBe(false);
});
it("caps scale, ids, time windows and query counts", () => {
  expect(TOOL_SCHEMAS.zenith_scale_service.safeParse({ ...argsFor("zenith_scale_service"), replicas: 11 }).success).toBe(false);
  expect(TOOL_SCHEMAS.zenith_query_logs.safeParse({ ...argsFor("zenith_query_logs"), lastMinutes: 10081 }).success).toBe(false);
  expect(TOOL_SCHEMAS.zenith_query_metrics.safeParse({ ...argsFor("zenith_query_metrics"), metrics: ["SQL or shell"] }).success).toBe(false);
});
