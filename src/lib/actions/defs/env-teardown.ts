/** Teardown changes infrastructure and always requires a browser human review. */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { proposeTeardown, teardownPlan } from "@/lib/bridge/destroy";
import { requireEnvironment } from "./_shared";
import { inFlight } from "./env";

const Input = z.object({ environmentId: z.string().min(1).max(200) }).strict();
defineAction<z.infer<typeof Input>>({
  id: "env.teardown", title: "Tear down environment infrastructure", category: "environment",
  risk: "high", requiredRole: "admin", mutates: true, input: Input,
  async plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const plan = await teardownPlan(ctx, env);
    if (inFlight(env.id)) plan.blocked = "Wait for the environment's active deployment to finish before proposing teardown.";
    return plan;
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    if (inFlight(env.id)) return { ok: false, summary: "Teardown refused.", error: "Wait for the environment's active deployment to finish." };
    return proposeTeardown(ctx, env);
  },
});
