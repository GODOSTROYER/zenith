/**
 * The deterministic Navigator planner.
 *
 * A goal in English becomes NavigatorStep[] of REGISTERED actions — the same
 * catalog the UI drives. There is no model in this file and no hidden second
 * vocabulary: if the Navigator can do it, you can do it by hand, and the plan
 * says exactly which action each step will call.
 *
 * Pure and server-side (it reads the action registry for risk).
 */
import { actionRegistry, type Risk } from "@/lib/actions/core";
import { registerAllActions } from "@/lib/actions/defs";
import {
  id,
  type Environment,
  type Manifest,
  type NavigatorStep,
  type Project,
  type ResourceKind,
  type SecurityFinding,
  type ServiceKind,
  type ServiceSize,
} from "@/lib/domain/types";
import { slugify, uniqueName } from "@/lib/importers/types";
import { BLOCKED, CLARIFY, INVESTIGATE, isExecutable } from "./shared";

/* --------------------------------- drafting -------------------------------- */

interface Draft {
  actionId: string;
  title: string;
  rationale: string;
  input: unknown;
  /** environment this step acts on — drives the approval rules */
  env?: Environment;
  /** set when the step targets production without an existing env record */
  production?: boolean;
  /** force the risk instead of reading the registry (pseudo-actions) */
  risk?: Risk;
}

type NodeType = "service" | "resource" | "route";

interface Ctx {
  manifest: Manifest;
  envs: Environment[];
  findings: SecurityFinding[];
  /** nodes this plan will have created by the time later steps run */
  pending: { name: string; type: NodeType }[];
  /** what the goal called a new node → the name it will actually get */
  aliases: Record<string, string>;
  /** target for "it" / "that" */
  lastAdded?: string;
  goal: string;
}

/* ------------------------------- vocabulary -------------------------------- */

/** Strong service nouns win over resource nouns ("a queue worker" is a worker). */
const SERVICE_STRONG: [RegExp, ServiceKind][] = [
  [/\b(worker|consumer)\b/, "worker"],
  [/\b(cron|scheduled job|scheduler|nightly job)\b/, "cron"],
  [/\b(static site|static)\b/, "static"],
  [/\b(web service|web app|website|api)\b/, "web"],
];

const RESOURCE_WORDS: [RegExp, ResourceKind][] = [
  [/\b(postgres(?:ql)?|database|db)\b/, "postgres"],
  [/\b(redis|cache)\b/, "redis"],
  [/\b(queue|message queue)\b/, "queue"],
  [/\b(bucket|object[ -]store|blob store|storage)\b/, "object_store"],
  [/\b(email|mailer|smtp)\b/, "email"],
];

const SERVICE_WEAK: [RegExp, ServiceKind][] = [
  [/\b(service|web|frontend|backend|app)\b/, "web"],
];

const SIZES: ServiceSize[] = ["nano", "small", "standard", "performance"];

/** Default node name when the goal did not give one. */
const RESOURCE_NAME: Record<ResourceKind, string> = {
  postgres: "postgres",
  redis: "cache",
  queue: "queue",
  object_store: "bucket",
  email: "email",
};

const KIND_LABEL: Record<ResourceKind, string> = {
  postgres: "Postgres database",
  redis: "Redis cache",
  queue: "queue",
  object_store: "object store",
  email: "email sender",
};

/* -------------------------------- splitting -------------------------------- */

/**
 * Goals arrive as one sentence of clauses. Split on the connectives people
 * actually type; a clause with no verb inherits the previous one's ("add a
 * worker and a queue").
 *
 * "and" and "then" must be surrounded by whitespace: a word boundary alone
 * splits inside a node name, and "restart search-and-index" is one clause
 * about one service, not two clauses about "search-" and "-index". A clause
 * left starting with the connective (", and a queue") drops it below.
 */
export function fragments(goal: string): string[] {
  return goal
    .split(/\s*[;,]\s*|\s+(?:then|and)\s+/i)
    .map((f) => f.trim().replace(/^(?:also|please|now|and|then)\s+/i, ""))
    .filter((f) => f.length > 0);
}

const ADD_VERB = /^(add|create|provision|spin\s?up|set\s?up|make)\b/i;

/* --------------------------------- helpers --------------------------------- */

const nodeNames = (m: Manifest): string[] => [
  ...m.services.map((s) => s.name),
  ...m.resources.map((r) => r.name),
  ...m.routes.map((r) => r.host),
];

const strip = (ref: string): string =>
  ref
    .trim()
    .replace(/^(?:the|a|an|my|our)\s+/i, "")
    .replace(/\s+(?:service|database|resource|node|instance)$/i, "")
    .replace(/[."']+$/g, "")
    .trim();

/** What kind of node a (resolved) name refers to. */
function typeOf(name: string, ctx: Ctx): NodeType | undefined {
  if (ctx.manifest.services.some((s) => s.name === name)) return "service";
  if (ctx.manifest.resources.some((r) => r.name === name)) return "resource";
  if (ctx.manifest.routes.some((r) => r.host === name)) return "route";
  return ctx.pending.find((p) => p.name === name)?.type;
}

/**
 * Confident node resolution: the same name, ignoring case, dashes and spaces.
 * Anything looser is a guess and goes through `nearMatch` instead.
 */
function resolveNode(ref: string, ctx: Ctx): string | undefined {
  const raw = strip(ref);
  if (!raw) return undefined;
  if (/^(it|that|them|this|those)$/i.test(raw)) return ctx.lastAdded;
  const lower = raw.toLowerCase();
  // a node this plan is about to create wins over an older node of that name
  if (ctx.aliases[lower]) return ctx.aliases[lower];
  const known = [...ctx.pending.map((p) => p.name), ...nodeNames(ctx.manifest)];
  return (
    known.find((n) => n === raw) ??
    known.find((n) => n.toLowerCase() === lower) ??
    known.find((n) => n.toLowerCase().replace(/-/g, "") === lower.replace(/[- ]/g, ""))
  );
}

/** The node a loose reference probably meant — "api" in a system with "api-gateway". */
function nearMatch(ref: string, ctx: Ctx): string | undefined {
  const lower = strip(ref).toLowerCase();
  if (!lower) return undefined;
  return [...ctx.pending.map((p) => p.name), ...nodeNames(ctx.manifest)].find(
    (n) => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase())
  );
}

/** Environment by name, then by class ("prod" → the production environment). */
function resolveEnv(ref: string | undefined, ctx: Ctx): Environment | undefined {
  if (!ref) return undefined;
  const raw = strip(ref).toLowerCase().replace(/\s+environment$/, "");
  const byName = ctx.envs.find((e) => e.name.toLowerCase() === raw);
  if (byName) return byName;
  const klass = raw === "prod" ? "production" : raw;
  return ctx.envs.find((e) => e.class === klass) ?? ctx.envs.find((e) => e.name.toLowerCase().includes(raw));
}

/** When no environment is named, take the least dangerous one that exists. */
const CLASS_ORDER = { sandbox: 0, staging: 1, production: 2 } as const;
function defaultEnv(ctx: Ctx): Environment | undefined {
  return [...ctx.envs].sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class])[0];
}

const blocked = (title: string, rationale: string): Draft => ({
  actionId: BLOCKED,
  title,
  rationale,
  input: {},
  risk: "low",
});

const knownList = (ctx: Ctx): string => {
  const names = [...nodeNames(ctx.manifest), ...ctx.pending.map((p) => p.name)];
  return names.length ? names.join(", ") : "(this system is empty)";
};

/**
 * A reference the planner could not resolve exactly.
 *
 * When something merely *contains* what you typed it is a guess, and acting on
 * the wrong node is not a guess worth making silently — the step becomes a
 * CLARIFY that names the candidate and asks. With no candidate at all it is
 * BLOCKED, as before.
 */
function unresolved(ref: string, ctx: Ctx, verb: string): Draft {
  const name = strip(ref);
  const near = nearMatch(ref, ctx);
  if (!near)
    return blocked(
      `Cannot ${verb} "${name}"`,
      `There is no node called "${name}" in this system. Known nodes: ${knownList(ctx)}.`
    );
  return {
    actionId: CLARIFY,
    title: `Did you mean "${near}"?`,
    rationale: `This system has no node called "${name}". The closest one is "${near}", but that is not what you typed, and ${verb} on the wrong node is not something to guess at. Say "${near}" exactly and plan again. Known nodes: ${knownList(ctx)}.`,
    input: {},
    risk: "low",
  };
}

/**
 * The name the manifest action will actually give this node. `system.add*`
 * slugifies and de-duplicates, so the planner does it here too — otherwise a
 * later "bind it to X" step would silently reference a different, older node.
 */
function claimName(raw: string, fallback: string, type: NodeType, ctx: Ctx): string {
  const taken = [
    ...ctx.manifest.services.map((s) => s.name),
    ...ctx.manifest.resources.map((r) => r.name),
    ...ctx.pending.map((p) => p.name),
  ];
  const name = uniqueName(slugify(raw, fallback), taken);
  ctx.pending.push({ name, type });
  ctx.aliases[raw.toLowerCase()] = name;
  ctx.aliases[fallback.toLowerCase()] ??= name;
  ctx.lastAdded = name;
  return name;
}

const envList = (ctx: Ctx): string =>
  ctx.envs.length ? ctx.envs.map((e) => e.name).join(", ") : "(none — create one first)";

/* ----------------------------- fragment parsing ---------------------------- */

/** Returns null when nothing in the grammar matched this clause. */
function parseFragment(frag: string, ctx: Ctx): Draft[] | null {
  const f = frag.trim();
  const lower = f.toLowerCase();

  /* investigate — read-only analysis, runs at any autonomy above observe */
  if (/\b(investigate|diagnose|look into|what went wrong|why did .* fail)\b/i.test(f)) {
    const env = resolveEnv(lower.match(/\b(?:in|on)\s+([a-z0-9-]+)/)?.[1], ctx);
    return [
      {
        actionId: INVESTIGATE,
        title: "Investigate the last failure",
        rationale:
          "Reads the most recent failed deployment, the step that failed, its provider error and the current health of the environment. Changes nothing.",
        input: { environmentId: env?.id },
        env,
        risk: "low",
      },
    ];
  }

  /* security findings */
  if (/\b(fix|resolve|clear|clean up)\b/i.test(f) && /\b(finding|findings|security)\b/i.test(f)) {
    const fixable = ctx.findings.filter((x) => x.fix);
    if (fixable.length === 0)
      return [
        blocked(
          "No security findings to fix",
          ctx.findings.length
            ? `${ctx.findings.length} open finding(s) have no automatic fix. Open Security to handle them by hand.`
            : "There are no open security findings on this project right now."
        ),
      ];
    return fixable.map((finding) => ({
      actionId: "security.resolveFinding",
      title: `Fix: ${finding.title}`,
      rationale: `${finding.detail} Runs ${finding.fix!.actionId} — ${finding.fix!.label}.`,
      input: { findingId: finding.id },
    }));
  }

  /* rollback */
  const rollback = f.match(/\broll\s?back\b(?:\s+(?:to\s+)?([a-z0-9-]+))?/i);
  if (rollback) {
    const env = resolveEnv(rollback[1], ctx) ?? defaultEnv(ctx);
    if (!env)
      return [blocked("Cannot roll back", `This project has no environments. Known environments: ${envList(ctx)}.`)];
    return [
      {
        actionId: "deploy.rollback",
        title: `Roll ${env.name} back`,
        rationale: `Redeploys the revision that was live in ${env.name} before the current one. Rollback restores the system definition, not data written since.`,
        input: { environmentId: env.id },
        env,
      },
    ];
  }

  /* deploy → a read-only plan step, then the apply step */
  if (/\b(deploy|ship|release|push)\b/i.test(f) && !/\bdeployment\b/i.test(lower)) {
    const env = resolveEnv(f.match(/\bto\s+([a-z0-9- ]+)$/i)?.[1], ctx) ?? defaultEnv(ctx);
    if (!env)
      return [blocked("Cannot deploy", `This project has no environments. Create one first (known: ${envList(ctx)}).`)];
    const named = /\bto\s+/i.test(f);
    return [
      {
        actionId: "deploy.plan",
        title: `Plan the deploy to ${env.name}`,
        rationale: `Reads the difference between the working copy and what is live in ${env.name}, with its cost delta and warnings. Read-only.`,
        input: { environmentId: env.id },
        env,
        risk: "low",
      },
      {
        actionId: "deploy.apply",
        title: `Deploy to ${env.name}`,
        rationale: named
          ? `Snapshots a revision and applies it to ${env.name}.${env.policies.approvalRequired ? ` ${env.name} requires approval, so the deployment will wait at "awaiting approval".` : ""}`
          : `No environment was named, so the Navigator picked ${env.name} — the least exposed environment on this project.${env.policies.approvalRequired ? ` It requires approval before anything is applied.` : ""}`,
        input: { environmentId: env.id, message: `Navigator: ${ctx.goal.slice(0, 80)}` },
        env,
      },
    ];
  }

  /* restart */
  const restart = f.match(/\brestart\s+(?:the\s+)?([a-z0-9- ]+?)(?:\s+(?:in|on)\s+([a-z0-9-]+))?$/i);
  if (restart) {
    const name = resolveNode(restart[1], ctx);
    if (!name) return [unresolved(restart[1], ctx, "restart")];
    const env = resolveEnv(restart[2], ctx) ?? defaultEnv(ctx);
    if (!env) return [blocked("Cannot restart", `This project has no environments (known: ${envList(ctx)}).`)];
    return [
      {
        actionId: "ops.restartService",
        title: `Restart ${name} in ${env.name}`,
        rationale: `Rolling restart of ${name} in the running ${env.name} environment. Nothing about the system definition changes.`,
        input: { serviceId: name, environmentId: env.id },
        env,
      },
    ];
  }

  /* scale / resize */
  const scale = f.match(/\bscale\s+(?:the\s+)?([a-z0-9-]+)\s+(?:to|up to|down to)\s+(\d+)/i);
  const resize = f.match(/\b(?:resize|size)\s+(?:the\s+)?([a-z0-9-]+)\s+to\s+(nano|small|standard|performance)\b/i);
  if (scale || resize) {
    const ref = (scale ?? resize)![1];
    const name = resolveNode(ref, ctx);
    if (!name) return [unresolved(ref, ctx, "resize")];
    const replicas = scale ? Number(scale[2]) : undefined;
    const size = resize ? (resize[2].toLowerCase() as ServiceSize) : undefined;
    const what = replicas !== undefined ? `${replicas} replica${replicas === 1 ? "" : "s"}` : size!;
    return [
      {
        actionId: "ops.scaleService",
        title: `Scale ${name} to ${what}`,
        rationale: `Changes ${name} to ${what} in the working copy, with the cost delta shown before anything is deployed.`,
        input: { serviceId: name, replicas, size },
      },
    ];
  }

  /* secrets before env vars — "set secret X on api" must not look like a var */
  const secret = f.match(/\bset\s+(?:the\s+)?secret\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\s+([a-z0-9-]+)/i);
  if (secret) {
    const name = resolveNode(secret[2], ctx);
    if (!name) return [unresolved(secret[2], ctx, `set ${secret[1]}`)];
    return [
      {
        actionId: "system.setSecret",
        title: `Store ${secret[1]} as a secret on ${name}`,
        rationale: `The manifest records only the reference vault:${secret[1]}; the value never reaches the manifest, the diff, the audit log or an export. Set the value on the service's Secrets panel.`,
        input: { serviceId: name, key: secret[1] },
      },
    ];
  }

  const envVar = f.match(
    /\bset\s+(?:the\s+)?(?:env(?:ironment)?\s*(?:var(?:iable)?)?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|\S+)(?:\s+(?:on|for)\s+([a-z0-9-]+))?/i
  );
  if (envVar) {
    const name = resolveNode(envVar[3] ?? "", ctx) ?? (ctx.manifest.services.length === 1 ? ctx.manifest.services[0].name : undefined);
    if (!name)
      return [
        envVar[3]
          ? unresolved(envVar[3], ctx, `set ${envVar[1]}`)
          : blocked(
              `Cannot set ${envVar[1]}`,
              `Say which service to set ${envVar[1]} on — this system has more than one (${knownList(ctx)}).`
            ),
      ];
    const value = envVar[2].replace(/^"|"$/g, "");
    return [
      {
        actionId: "system.setEnvVar",
        title: `Set ${envVar[1]} on ${name}`,
        rationale: `Adds ${envVar[1]} to ${name}'s environment in the working copy. Deploy to apply it.`,
        input: { serviceId: name, key: envVar[1], value },
      },
    ];
  }

  /* budget */
  if (/\bbudget\b/i.test(f)) {
    const amount = f.match(/\$\s*(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*(?:usd|dollars)\b/i);
    const env = resolveEnv(f.match(/\bon\s+([a-z0-9-]+)/i)?.[1], ctx) ?? defaultEnv(ctx);
    if (!env) return [blocked("Cannot set a budget", `This project has no environments (known: ${envList(ctx)}).`)];
    if (/\b(remove|clear|drop|no)\b/i.test(f) && !amount)
      return [
        {
          actionId: "env.setBudget",
          title: `Remove the budget on ${env.name}`,
          rationale: `Plans for ${env.name} will no longer be checked against a monthly limit.`,
          input: { environmentId: env.id, budgetUsdMonthly: null },
          env,
        },
      ];
    if (!amount)
      return [blocked("Budget amount missing", `Say the amount, for example "set a $100 budget on ${env.name}".`)];
    const usd = Number(amount[1] ?? amount[2]);
    return [
      {
        actionId: "env.setBudget",
        title: `Set a $${usd}/month budget on ${env.name}`,
        rationale: `Budgets warn before a deploy that would exceed them (estimates). They never stop a running system or delete anything.`,
        input: { environmentId: env.id, budgetUsdMonthly: usd },
        env,
      },
    ];
  }

  /* create environment — must beat the generic "create" rule below */
  const createEnv = f.match(
    /\b(?:create|add|make|spin\s?up|set\s?up)\s+(?:an?\s+)?(?:new\s+)?(staging|production|prod|sandbox)?\s*environment(?:\s+(?:named|called)\s+([a-z0-9-]+))?/i
  );
  if (createEnv) {
    const raw = (createEnv[1] ?? "sandbox").toLowerCase();
    const klass = raw === "prod" ? "production" : (raw as Environment["class"]);
    const name = createEnv[2] ?? klass;
    return [
      {
        actionId: "env.create",
        title: `Create the "${name}" environment`,
        rationale:
          klass === "production"
            ? "Production environments require approval before anything is applied — that default is set at creation and can be changed in Settings → Environments."
            : `A ${klass} environment on the sandbox connection. Creating it costs nothing; nothing is deployed to it yet.`,
        input: { name, class: klass },
        production: klass === "production",
      },
    ];
  }

  /* connect / bind */
  const bind = f.match(/\b(?:connect|bind|attach|link|wire)\s+(.+?)\s+(?:to|into|with)\s+(.+)$/i);
  if (bind) {
    const from = resolveNode(bind[1], ctx);
    const to = resolveNode(bind[2], ctx);
    // One step per unresolved end, so the plan still accounts for the whole
    // clause and each half carries its own fix.
    if (!from || !to)
      return [!from ? bind[1] : "", !to ? bind[2] : ""]
        .filter(Boolean)
        .map((ref) => unresolved(ref, ctx, "connect"));
    // Orrery records a binding in the direction config flows: consumer → thing
    // consumed (route → service → resource). "bind the cache to web" means the
    // same edge as "bind web to the cache", so orient it rather than fail.
    const [ft, tt] = [typeOf(from, ctx), typeOf(to, ctx)];
    const flipped =
      (ft === "resource" && tt !== "resource") || (ft === "service" && tt === "route");
    const [consumer, provider] = flipped ? [to, from] : [from, to];
    return [
      {
        actionId: "system.bind",
        title: `Connect ${consumer} to ${provider}`,
        rationale: `Orrery picks the capability from what ${provider} is, injects the connection config into ${consumer}, and opens the network path.${
          flipped ? ` Recorded as ${consumer} → ${provider}, the direction configuration flows.` : ""
        } Deploy to apply it.`,
        input: { from: consumer, to: provider },
      },
    ];
  }

  /* add / create a node */
  if (ADD_VERB.test(f)) {
    const named = f.match(/\b(?:named|called)\s+"?([a-z0-9][a-z0-9- ]*?)"?(?:\s+(?:from|using|with|on)\b|$)/i)?.[1]?.trim();
    const image = f.match(/\b(?:from|using)\s+(?:the\s+)?image\s+(\S+)/i)?.[1];
    const repo = f.match(/\b(?:from|using)\s+(?:repo(?:sitory)?\s+)?((?:https?:\/\/)?[\w.-]+\/[\w./-]+)/i)?.[1];
    const size = SIZES.find((s) => new RegExp(`\\b${s}\\b`, "i").test(f));

    const svcStrong = SERVICE_STRONG.find(([re]) => re.test(lower));
    const res = RESOURCE_WORDS.find(([re]) => re.test(lower));
    const svcWeak = SERVICE_WEAK.find(([re]) => re.test(lower));

    if (!svcStrong && res) {
      const kind = res[1];
      const name = claimName(named ?? RESOURCE_NAME[kind], RESOURCE_NAME[kind], "resource", ctx);
      return [
        {
          actionId: "system.addResource",
          title: `Add ${KIND_LABEL[kind]} "${name}"`,
          rationale: `Adds a managed ${kind.replace("_", " ")} to the working copy. Its cost appears in the plan before you deploy.`,
          input: { name, kind, size },
        },
      ];
    }

    const kind = (svcStrong ?? svcWeak)?.[1];
    if (kind) {
      const name = claimName(named ?? kind, kind, "service", ctx);
      return [
        {
          actionId: "system.addService",
          title: `Add ${kind} service "${name}"`,
          rationale: image
            ? `Runs ${image} as a ${kind} service in the working copy.`
            : repo
              ? `Builds ${repo} and runs it as a ${kind} service in the working copy.`
              : `Adds a ${kind} service to the working copy. No image or repository was given, so it points at the Orrery sample image until you set a real source.`,
          input: { name, kind, image, repo, size },
        },
      ];
    }
  }

  return null;
}

/* ------------------------------ risk + approval ---------------------------- */

function riskOf(actionId: string): Risk {
  registerAllActions();
  return actionRegistry().get(actionId)?.risk ?? "low";
}

/**
 * The role `runAction` will demand of the human who presses Run. Recorded on
 * the step so the run panel can disable Run and name the role before the
 * refusal; the executor still re-reads the registry, which is the authority.
 */
function requiredRoleOf(actionId: string): NavigatorStep["requiredRole"] {
  registerAllActions();
  return actionRegistry().get(actionId)?.requiredRole;
}

const DESTRUCTIVE = /^system\.(remove|unbind)/;

function needsApprovalFor(d: Draft, risk: Risk): boolean {
  if (!isExecutable(d.actionId) || d.actionId === INVESTIGATE) return false;
  if (d.env?.class === "production" || d.production) return true;
  if (d.actionId === "deploy.apply" && d.env?.policies?.approvalRequired) return true;
  if (DESTRUCTIVE.test(d.actionId)) return true;
  return risk !== "low";
}

/* ---------------------------------- entry ---------------------------------- */

/**
 * Parse a goal into a plan. Unresolved references and unparsed clauses become
 * visible, non-executable steps rather than silent omissions — the plan always
 * accounts for the whole sentence.
 */
export function parseGoal(
  goal: string,
  project: Project,
  environments: Environment[],
  findings: SecurityFinding[] = []
): NavigatorStep[] {
  registerAllActions();
  const ctx: Ctx = {
    manifest: project.workingManifest,
    envs: environments,
    findings: findings.filter((f) => f.status === "open"),
    pending: [],
    aliases: {},
    goal: goal.trim(),
  };

  const drafts: Draft[] = [];
  let carryAdd = false;

  for (const frag of fragments(goal)) {
    let parsed = parseFragment(frag, ctx);
    // "add a worker and a queue" — a verbless clause inherits the previous verb
    if (!parsed && carryAdd) parsed = parseFragment(`add ${frag}`, ctx);
    if (!parsed) {
      drafts.push({
        actionId: CLARIFY,
        title: "Needs clarification",
        rationale: `I did not understand: "${frag}". Rephrase it, or make that change from the System Map — every Navigator step is an action you can run yourself.`,
        input: {},
        risk: "low",
      });
      carryAdd = false;
      continue;
    }
    carryAdd = ADD_VERB.test(frag);
    drafts.push(...parsed);
  }

  if (drafts.length === 0)
    drafts.push({
      actionId: CLARIFY,
      title: "Needs clarification",
      rationale: `I did not understand: "${goal.trim()}". Try something like "add a redis cache and bind it to web, then deploy to staging".`,
      input: {},
      risk: "low",
    });

  return drafts.map((d, i): NavigatorStep => {
    const risk = d.risk ?? riskOf(d.actionId);
    return {
      id: id(),
      seq: i + 1,
      title: d.title,
      rationale: d.rationale,
      actionId: d.actionId,
      input: d.input,
      risk,
      requiredRole: requiredRoleOf(d.actionId),
      needsApproval: needsApprovalFor(d, risk),
      status: "proposed",
    };
  });
}
